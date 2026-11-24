'use strict';
// Chave "anon" é pública por design: a segurança real está nas políticas RLS (schema.sql).
// NUNCA coloque aqui a chave service_role.
const SUPABASE_URL = 'https://yiyrgzymbxrqygdmrwdn.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpeXJnenltYnhycXlnZG1yd2RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1NTkyMjYsImV4cCI6MjExMTEzNTIyNn0.oYfViKI2yhEB_TMsTR98xOOThOZnb1dL1olVF1MBskA';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById('app'), nav = document.getElementById('nav'), toast = document.getElementById('toast');
const CONTRATOS = ['CLT', 'PJ', 'Estágio'], MODOS = ['Presencial', 'Híbrido', 'Remoto'];
let me = null;
const viewed = new Set();

// Todo conteúdo entra via textContent/atributos (nunca innerHTML) => sem XSS.
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    k.startsWith('on') ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v);
  }
  e.append(...kids.flat().filter(x => x != null && x !== false));
  return e;
};
const say = (t, bad) => { toast.textContent = t; toast.className = bad ? 'bad show' : 'show'; setTimeout(() => toast.className = '', 3500); };
const money = v => v == null ? '' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const f = (label, name, type = 'text', val = '', extra = {}) => h('label', {}, label, h('input', { name, type, value: val ?? '', maxlength: '120', ...extra }));
const sel = (name, label, opts, val) => h('label', {}, label, h('select', { name }, opts.map(o => h('option', { value: o, selected: o === val ? '' : null }, o || 'Todos'))));
const data = form => Object.fromEntries(new FormData(form));
const isCand = () => me && !me.is_company;

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  me = null;
  if (session) ({ data: me } = await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
  const L = (href, t) => h('a', { href }, t);
  nav.replaceChildren(L('#/vagas', 'Vagas'),
    ...(!me ? [L('#/entrar', 'Entrar'), L('#/cadastro', 'Cadastrar')]
      : me.is_company ? [L('#/painel', 'Minhas vagas'), L('#/publicar', 'Publicar'), L('#/perfil', 'Perfil')]
        : [L('#/favoritas', 'Favoritas'), L('#/candidaturas', 'Candidaturas'), L('#/perfil', 'Perfil')]),
    ...(me ? [h('a', { href: '#/vagas', onclick: async () => { await sb.auth.signOut(); } }, 'Sair')] : []));
  route();
}

const pages = {
  vagas, entrar, cadastro,
  favoritas: () => minhas('favorites', 'Vagas favoritas'),
  candidaturas: () => minhas('applications', 'Minhas candidaturas'),
  perfil, publicar, painel,
};
const needs = { favoritas: 'c', candidaturas: 'c', perfil: 'any', publicar: 'e', painel: 'e' };

async function route() {
  const name = location.hash.slice(2) || 'vagas', need = needs[name];
  if (!pages[name]) return app.replaceChildren(h('p', {}, 'Página não encontrada.'));
  if (need && (!me || (need === 'c' && me.is_company) || (need === 'e' && !me.is_company))) { location.hash = '#/entrar'; return; }
  app.replaceChildren(await pages[name]());
}

function card(v, { favs, apps, extra } = {}) {
  const det = h('details', {}, h('summary', {}, 'Requisitos'), h('p', {}, v.requirements));
  det.addEventListener('toggle', async () => { // conta 1 visualização por sessão, de forma atômica no servidor
    if (det.open && !viewed.has(v.id)) { viewed.add(v.id); await sb.rpc('increment_views', { vid: v.id }); }
  });
  const acts = h('div', { class: 'actions' });
  if (favs) acts.append(toggler('favorites', v, favs, '★ Favoritada', '☆ Favoritar'), toggler('applications', v, apps, 'Retirar candidatura', 'Candidatar-me'));
  if (extra) acts.append(extra);
  return h('div', { class: 'card' }, h('h3', {}, v.title), h('div', {}, v.company_name),
    h('div', { class: 'tags' }, [v.contract_type, v.work_mode, v.location, (v.salary_min || v.salary_max) && `${money(v.salary_min)} – ${money(v.salary_max)}`, 'Prazo: ' + new Date(v.deadline + 'T12:00').toLocaleDateString('pt-BR')].filter(Boolean).map(t => h('span', {}, t))),
    det, acts);
}

function toggler(table, v, set, on, off) {
  const b = h('button', { class: table === 'favorites' ? 'alt' : '' }, set.has(v.id) ? on : off);
  b.onclick = async () => {
    if (!me) { location.hash = '#/entrar'; return; }
    if (me.is_company) return say('Entre como candidato para usar este recurso.', 1);
    const has = set.has(v.id);
    const { error } = has ? await sb.from(table).delete().eq('vacancy_id', v.id).eq('candidate_id', me.id) : await sb.from(table).insert({ vacancy_id: v.id });
    if (error) return say('Não foi possível concluir a ação.', 1);
    has ? set.delete(v.id) : set.add(v.id);
    b.textContent = has ? off : on;
  };
  return b;
}

async function vagas() {
  const { data: vs, error } = await sb.from('vacancies').select('*').gte('deadline', new Date().toISOString().slice(0, 10)).order('created_at', { ascending: false }).limit(200);
  if (error) return h('p', {}, 'Erro ao carregar vagas.');
  const favs = new Set(), apps = new Set();
  if (isCand()) {
    const [a, b] = await Promise.all([sb.from('favorites').select('vacancy_id'), sb.from('applications').select('vacancy_id')]);
    (a.data || []).forEach(x => favs.add(x.vacancy_id)); (b.data || []).forEach(x => apps.add(x.vacancy_id));
  }
  const q = h('input', { type: 'search', placeholder: 'Cargo, empresa ou local' }), t = sel('t', 'Contrato', ['', ...CONTRATOS]), m = sel('m', 'Modalidade', ['', ...MODOS]);
  const list = h('div');
  const draw = () => {
    const s = q.value.trim().toLowerCase(), ct = t.querySelector('select').value, md = m.querySelector('select').value;
    const r = vs.filter(v => (!s || `${v.title} ${v.company_name} ${v.location}`.toLowerCase().includes(s)) && (!ct || v.contract_type === ct) && (!md || v.work_mode === md));
    list.replaceChildren(...(r.length ? r.map(v => card(v, { favs, apps })) : [h('p', {}, 'Nenhuma vaga encontrada.')]));
  };
  [q, t, m].forEach(x => x.addEventListener('input', draw)); draw();
  return h('div', {}, h('h2', {}, 'Vagas'), h('div', { class: 'card' }, q, t, m), list);
}

async function minhas(table, title) {
  const { data: rows } = await sb.from(table).select('vacancy_id, vacancies(*)').order('created_at', { ascending: false });
  const list = (rows || []).filter(r => r.vacancies).map(r => {
    const set = new Set([r.vacancy_id]);
    return card(r.vacancies, { extra: h('button', { class: 'alt', onclick: async () => { await sb.from(table).delete().eq('vacancy_id', r.vacancy_id).eq('candidate_id', me.id); route(); } }, 'Remover') });
  });
  return h('div', {}, h('h2', {}, title), list.length ? list : h('p', {}, 'Nada por aqui ainda.'));
}

function entrar() {
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault(); const d = data(form);
      const { error } = await sb.auth.signInWithPassword({ email: d.email, password: d.password });
      if (error) return say('E-mail ou senha incorretos.', 1);
      location.hash = '#/vagas';
    }
  }, h('h2', {}, 'Entrar'), f('E-mail', 'email', 'email', '', { required: '', autocomplete: 'email' }), f('Senha', 'password', 'password', '', { required: '', autocomplete: 'current-password' }), h('button', {}, 'Entrar'));
  return form;
}

function cadastro() {
  const tipo = h('select', { name: 'is_company' }, h('option', { value: '0' }, 'Sou candidato'), h('option', { value: '1' }, 'Sou empresa'));
  const co = h('div', { hidden: '' }, f('Razão social', 'company_social_reason'), f('CNPJ (14 números)', 'company_cnpj', 'text', '', { inputmode: 'numeric' }), sel('company_size', 'Porte', ['Pequena', 'Média', 'Grande']));
  tipo.onchange = () => co.hidden = tipo.value !== '1';
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault(); const d = data(form), c = d.is_company === '1';
      if (d.password.length < 8) return say('A senha precisa ter ao menos 8 caracteres.', 1);
      if (c && (!d.company_social_reason || !/^\d{14}$/.test(d.company_cnpj))) return say('Informe razão social e um CNPJ válido (14 números).', 1);
      const { data: r, error } = await sb.auth.signUp({ email: d.email, password: d.password, options: { data: { name: d.name, phone: d.phone, is_company: c, company_social_reason: c ? d.company_social_reason : null, company_cnpj: c ? d.company_cnpj : null, company_size: c ? d.company_size : null } } });
      if (error) return say('Não foi possível criar a conta: ' + error.message, 1);
      say(r.session ? 'Conta criada!' : 'Confirme seu e-mail para entrar.');
      location.hash = r.session ? '#/perfil' : '#/entrar';
    }
  }, h('h2', {}, 'Criar conta'), h('label', {}, 'Tipo de conta', tipo), f('Nome', 'name', 'text', '', { required: '' }), f('Telefone', 'phone', 'tel'), f('E-mail', 'email', 'email', '', { required: '', autocomplete: 'email' }), f('Senha (mín. 8)', 'password', 'password', '', { required: '', minlength: '8', autocomplete: 'new-password' }), co, h('button', {}, 'Cadastrar'));
  return form;
}

function items(table, title, fields) {
  const list = h('div');
  const load = async () => {
    const { data: rows } = await sb.from(table).select('*').order('created_at');
    list.replaceChildren(...(rows || []).map(r => h('div', { class: 'row' }, fields.map(([k]) => r[k]).join(' · '),
      h('button', { class: 'alt', onclick: async () => { await sb.from(table).delete().eq('id', r.id); load(); } }, 'Remover'))));
  };
  const form = h('form', {
    class: 'inline', onsubmit: async e => {
      e.preventDefault();
      const { error } = await sb.from(table).insert(data(form));
      if (error) return say('Erro ao salvar.', 1);
      form.reset(); load();
    }
  }, fields.map(([k, l]) => h('input', { name: k, placeholder: l, required: '', maxlength: '120' })), h('button', {}, 'Adicionar'));
  load();
  return h('section', {}, h('h3', {}, title), list, form);
}

function perfil() {
  const c = me.is_company;
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      const { error } = await sb.from('profiles').update(data(form)).eq('id', me.id);
      if (error) return say('Erro ao salvar o perfil.', 1);
      say('Perfil salvo!'); boot();
    }
  }, h('h2', {}, 'Meu perfil'), f('Nome', 'name', 'text', me.name), f('Telefone', 'phone', 'tel', me.phone),
    ...(c ? [f('Razão social', 'company_social_reason', 'text', me.company_social_reason), sel('company_size', 'Porte', ['Pequena', 'Média', 'Grande'], me.company_size)]
      : [f('Título profissional', 'professional_title', 'text', me.professional_title), f('Habilidades (separadas por vírgula)', 'skills', 'text', me.skills, { maxlength: '300' }),
        h('label', {}, 'Resumo profissional', h('textarea', { name: 'professional_summary', maxlength: '1000', rows: '4' }, me.professional_summary || ''))]),
    h('button', {}, 'Salvar'));
  return h('div', {}, form, ...(c ? [] : [
    items('experiences', 'Experiências', [['title', 'Cargo'], ['company_name', 'Empresa'], ['period', 'Período'], ['work_mode', 'Modalidade']]),
    items('educations', 'Formação', [['degree', 'Curso'], ['institution', 'Instituição'], ['period', 'Período']])]));
}

function publicar() {
  const today = new Date().toISOString().slice(0, 10);
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault(); const d = data(form);
      const min = d.salary_min === '' ? null : +d.salary_min, max = d.salary_max === '' ? null : +d.salary_max;
      if (min != null && max != null && min > max) return say('O salário mínimo não pode ser maior que o máximo.', 1);
      const { error } = await sb.from('vacancies').insert({ ...d, salary_min: min, salary_max: max, company_name: me.company_social_reason || me.name });
      if (error) return say('Erro ao publicar a vaga.', 1);
      say('Vaga publicada!'); location.hash = '#/painel';
    }
  }, h('h2', {}, 'Publicar vaga'), f('Título', 'title', 'text', '', { required: '' }), sel('contract_type', 'Contrato', CONTRATOS), sel('work_mode', 'Modalidade', MODOS),
    f('Local', 'location', 'text', '', { required: '' }), f('Salário mínimo (R$)', 'salary_min', 'number', '', { min: '0', step: '0.01' }), f('Salário máximo (R$)', 'salary_max', 'number', '', { min: '0', step: '0.01' }),
    h('label', {}, 'Requisitos', h('textarea', { name: 'requirements', required: '', maxlength: '2000', rows: '4' })), f('Prazo', 'deadline', 'date', '', { required: '', min: today }), h('button', {}, 'Publicar'));
  return form;
}

async function painel() {
  const { data: vs } = await sb.from('vacancies').select('*, applications(count)').eq('company_id', me.id).order('created_at', { ascending: false });
  const cards = (vs || []).map(v => {
    const box = h('div'), n = v.applications?.[0]?.count ?? 0;
    const b = h('button', { class: 'alt', onclick: async () => {
      if (box.childElementCount) return box.replaceChildren();
      const { data: cs } = await sb.from('applications').select('profiles(name,email,phone,professional_title,skills)').eq('vacancy_id', v.id);
      box.replaceChildren(...(cs || []).map(c => c.profiles).filter(Boolean).map(p => h('div', { class: 'row' }, `${p.name} — ${p.professional_title || 'sem título'} · ${p.email} ${p.phone}`)), ...(cs?.length ? [] : [h('p', {}, 'Sem candidatos ainda.')]));
    } }, `Candidatos (${n})`);
    const del = h('button', { class: 'alt', onclick: async () => { if (confirm('Excluir esta vaga?')) { await sb.from('vacancies').delete().eq('id', v.id); route(); } } }, 'Excluir');
    return h('div', {}, card(v, { extra: h('span', {}, b, ' ', del, ` 👁 ${v.views_count}`) }), box);
  });
  return h('div', {}, h('h2', {}, 'Minhas vagas'), cards.length ? cards : h('p', {}, 'Você ainda não publicou vagas.'));
}

sb.auth.onAuthStateChange(() => setTimeout(boot, 0)); // setTimeout evita deadlock dentro do callback
window.addEventListener('hashchange', route);
