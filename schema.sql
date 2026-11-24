-- Estagiagros: rode este arquivo inteiro no SQL Editor do Supabase.
-- Senhas ficam SOMENTE no Supabase Auth (hash). CPF não é mais coletado (minimização de dados / LGPD).

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  name text not null default '' check (char_length(name) <= 120),
  phone text not null default '' check (char_length(phone) <= 30),
  is_company boolean not null default false,
  company_social_reason text, company_cnpj text check (company_cnpj is null or company_cnpj ~ '^\d{14}$'),
  company_size text check (company_size in ('Pequena','Média','Grande')),
  professional_title text, professional_summary text check (char_length(professional_summary) <= 1000),
  skills text check (char_length(skills) <= 300),
  created_at timestamptz not null default now()
);
create table public.experiences (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  title text not null, company_name text not null, period text not null, work_mode text not null,
  created_at timestamptz not null default now()
);
create table public.educations (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  degree text not null, institution text not null, period text not null,
  created_at timestamptz not null default now()
);
create table public.vacancies (
  id bigint generated always as identity primary key,
  company_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  company_name text not null, title text not null,
  contract_type text not null check (contract_type in ('CLT','PJ','Estágio')),
  work_mode text not null check (work_mode in ('Presencial','Híbrido','Remoto')),
  location text not null,
  salary_min numeric check (salary_min >= 0), salary_max numeric check (salary_max >= 0),
  requirements text not null check (char_length(requirements) <= 2000),
  deadline date not null, views_count integer not null default 0,
  created_at timestamptz not null default now(),
  check (salary_min is null or salary_max is null or salary_min <= salary_max)
);
create table public.applications (
  id bigint generated always as identity primary key,
  vacancy_id bigint not null references public.vacancies(id) on delete cascade,
  candidate_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(), unique (vacancy_id, candidate_id)
);
create table public.favorites (
  id bigint generated always as identity primary key,
  vacancy_id bigint not null references public.vacancies(id) on delete cascade,
  candidate_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(), unique (vacancy_id, candidate_id)
);
create index on public.vacancies (company_id); create index on public.applications (candidate_id);
create index on public.favorites (candidate_id);

-- Cria o perfil automaticamente no cadastro (funciona mesmo com confirmação de e-mail ligada)
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, name, phone, is_company, company_social_reason, company_cnpj, company_size)
  values (new.id, new.email, left(coalesce(new.raw_user_meta_data->>'name',''),120), left(coalesce(new.raw_user_meta_data->>'phone',''),30),
    coalesce((new.raw_user_meta_data->>'is_company')::boolean,false), nullif(new.raw_user_meta_data->>'company_social_reason',''),
    nullif(new.raw_user_meta_data->>'company_cnpj',''), nullif(new.raw_user_meta_data->>'company_size',''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Contador de visualizações atômico (substitui o "ler e gravar" do app, que perdia contagens)
create function public.increment_views(vid bigint) returns void language sql security definer set search_path = '' as $$
  update public.vacancies set views_count = views_count + 1 where id = vid $$;

-- RLS: nada é acessível sem política explícita
alter table public.profiles enable row level security;   alter table public.experiences enable row level security;
alter table public.educations enable row level security; alter table public.vacancies enable row level security;
alter table public.applications enable row level security; alter table public.favorites enable row level security;

create policy "perfil: ver o proprio ou de quem se candidatou a minha vaga" on public.profiles for select to authenticated
  using (id = auth.uid() or exists (select 1 from public.applications a join public.vacancies v on v.id = a.vacancy_id
         where a.candidate_id = profiles.id and v.company_id = auth.uid()));
create policy "perfil: editar o proprio (sem trocar o tipo de conta)" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and is_company = (select p.is_company from public.profiles p where p.id = auth.uid()));

create policy "dados do candidato: so o dono" on public.experiences for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "formacao: so o dono" on public.educations for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "vagas: qualquer um le" on public.vacancies for select to anon, authenticated using (true);
create policy "vagas: empresa publica" on public.vacancies for insert to authenticated
  with check (company_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and is_company));
create policy "vagas: empresa edita as suas" on public.vacancies for update to authenticated using (company_id = auth.uid()) with check (company_id = auth.uid());
create policy "vagas: empresa exclui as suas" on public.vacancies for delete to authenticated using (company_id = auth.uid());

create policy "candidaturas: candidato ou empresa dona da vaga le" on public.applications for select to authenticated
  using (candidate_id = auth.uid() or exists (select 1 from public.vacancies v where v.id = vacancy_id and v.company_id = auth.uid()));
create policy "candidaturas: candidato cria" on public.applications for insert to authenticated
  with check (candidate_id = auth.uid() and exists (select 1 from public.profiles where id = auth.uid() and not is_company));
create policy "candidaturas: candidato retira" on public.applications for delete to authenticated using (candidate_id = auth.uid());

create policy "favoritos: so o dono" on public.favorites for all to authenticated using (candidate_id = auth.uid()) with check (candidate_id = auth.uid());
