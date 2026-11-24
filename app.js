'use strict';
// Chave "anon" é pública por design: a segurança real está nas políticas RLS (schema.sql).
// NUNCA coloque aqui a chave service_role.
const SUPABASE_URL = 'https://yiyrgzymbxrqygdmrwdn.supabase.co/rest/v1/';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlpeXJnenltYnhycXlnZG1yd2RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU1NTkyMjYsImV4cCI6MjExMTEzNTIyNn0.oYfViKI2yhEB_TMsTR98xOOThOZnb1dL1olVF1MBskA';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById('app'), nav = document.getElementById('nav'), toast = document.getElementById('toast');
const CONTRATOS = ['CLT', 'PJ', 'Estágio'], MODOS = ['Presencial', 'Híbrido', 'Remoto'];
const ROLE = { candidate: 'Candidato', company: 'Empresa', admin: 'Administrador' };
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
const digits = s => (s || '').replace(/\D/g, '');
const today = () => new Date().toISOString().slice(0, 10);
const role = () => me?.role;
 
function okCPF(s) {
  s = digits(s); if (s.length !== 11 || /^(\d)\1+$/.test(s)) return false;
  for (let t = 9; t < 11; t++) { let d = 0; for (let i = 0; i < t; i++) d += s[i] * (t + 1 - i); if (+s[t] !== (d * 10) % 11 % 10) return false; }
  return true;
}
function okCNPJ(s) {
  s = digits(s); if (s.length !== 14 || /^(\d)\1+$/.test(s)) return false;
  const c = n => { let p = n - 7, d = 0; for (let i = 0; i < n; i++) { d += s[i] * p--; if (p < 2) p = 9; } return d % 11 < 2 ? 0 : 11 - d % 11; };
  return c(12) === +s[12] && c(13) === +s[13];
}
 
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  me = null;
  if (session) {
    const [p, d] = await Promise.all([sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle(), sb.from('dados_pessoais').select('*').eq('id', session.user.id).maybeSingle()]);
    me = p.data;
    if (me && !me.active) { me = null; await sb.auth.signOut(); say('Sua conta está bloqueada. Fale com o administrador.', 1); }
    if (me) {
      me.priv = d.data || {};
      me.complete = role() === 'admin' || (!!me.name && !!me.phone && !!me.priv.address &&
        (role() === 'company' ? !!me.cnpj && !!me.company_social_reason : !!me.priv.cpf && !!me.priv.birth_date && !!me.school));
    }
  }
  const L = (href, t) => h('a', { href }, t);
  nav.replaceChildren(L('#/vagas', 'Oportunidades'),
    ...(!me ? [L('#/entrar', 'Entrar'), L('#/cadastro', 'Cadastrar')]
      : role() === 'admin' ? [L('#/admin', 'Administração'), L('#/publicar', 'Nova vaga'), L('#/perfil', 'Perfil')]
        : role() === 'company' ? [L('#/painel', 'Minhas vagas'), L('#/publicar', 'Publicar'), L('#/perfil', 'Perfil')]
          : [L('#/candidaturas', 'Vagas que concorro'), L('#/favoritas', 'Favoritas'), L('#/perfil', 'Meu perfil')]),
    ...(me ? [h('a', { href: '#/vagas', onclick: () => sb.auth.signOut() }, 'Sair')] : []));
  route();
}
 
const pages = { vagas, entrar, cadastro, favoritas: () => minhas('favorites', 'Vagas favoritas'), candidaturas: () => minhas('applications', 'Vagas que estou concorrendo'), perfil, publicar, painel, admin };
const needs = { favoritas: ['candidate'], candidaturas: ['candidate'], perfil: ['candidate', 'company', 'admin'], publicar: ['company', 'admin'], painel: ['company'], admin: ['admin'] };
 
async function route() {
  const name = location.hash.slice(2) || 'vagas', need = needs[name];
  nav.querySelectorAll('a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === '#/' + name));
  if (!pages[name]) return app.replaceChildren(h('p', {}, 'Página não encontrada.'));
  if (need && !(me && need.includes(role()))) { location.hash = '#/entrar'; return; }
  if (me && !me.complete && name !== 'perfil') { say('Complete seu cadastro para continuar.', 1); location.hash = '#/perfil'; return; }
  app.replaceChildren(await pages[name]());
}
 
async function openResume(path) {
  const { data: d, error } = await sb.storage.from('curriculos').createSignedUrl(path, 60);
  if (error) return say('Sem acesso ao currículo.', 1);
  window.open(d.signedUrl, '_blank', 'noopener');
}
 
function card(v, { favs, apps, extra } = {}) {
  const det = h('details', {}, h('summary', {}, 'Função, horário e requisitos'),
    h('p', {}, 'Função: ' + v.funcao), h('p', {}, 'Horário: ' + v.schedule), h('p', {}, 'Local: ' + v.location), h('p', {}, v.requirements));
  det.addEventListener('toggle', async () => { // 1 visualização por sessão, contada de forma atômica no servidor
    if (det.open && !viewed.has(v.id)) { viewed.add(v.id); await sb.rpc('increment_views', { vid: v.id }); }
  });
  const acts = h('div', { class: 'actions' });
  if (favs) acts.append(toggler('applications', v, apps, 'Retirar candidatura', 'Candidatar-me'), toggler('favorites', v, favs, '★ Favoritada', '☆ Favoritar'));
  if (extra) acts.append(extra);
  return h('div', { class: 'card' }, h('h3', {}, v.title), h('div', {}, v.company_name),
    h('div', { class: 'tags' }, [v.funcao, '🕒 ' + v.schedule, '📍 ' + v.location, v.contract_type, v.work_mode, (v.salary_min || v.salary_max) && `${money(v.salary_min)} – ${money(v.salary_max)}`, 'Prazo: ' + new Date(v.deadline + 'T12:00').toLocaleDateString('pt-BR')].filter(Boolean).map(t => h('span', {}, t))),
    det, acts);
}
 
function toggler(table, v, set, on, off) {
  const b = h('button', { class: table === 'favorites' ? 'alt' : '' }, set.has(v.id) ? on : off);
  b.onclick = async () => {
    if (!me) { location.hash = '#/entrar'; return; }
    if (role() !== 'candidate') return say('Entre como candidato para usar este recurso.', 1);
    const has = set.has(v.id);
    const { error } = has ? await sb.from(table).delete().eq('vacancy_id', v.id).eq('candidate_id', me.id) : await sb.from(table).insert({ vacancy_id: v.id });
    if (error) return say('Não foi possível concluir a ação.', 1);
    has ? set.delete(v.id) : set.add(v.id);
    b.textContent = has ? off : on;
  };
  return b;
}
 
async function vagas() {
  const { data: vs, error } = await sb.from('vacancies').select('*').gte('deadline', today()).order('created_at', { ascending: false }).limit(200);
  if (error) return h('p', {}, 'Erro ao carregar vagas.');
  const favs = new Set(), apps = new Set();
  if (role() === 'candidate') {
    const [a, b] = await Promise.all([sb.from('favorites').select('vacancy_id'), sb.from('applications').select('vacancy_id')]);
    (a.data || []).forEach(x => favs.add(x.vacancy_id)); (b.data || []).forEach(x => apps.add(x.vacancy_id));
  }
  const q = h('input', { type: 'search', placeholder: 'Cargo, função, empresa ou local' }), t = sel('t', 'Contrato', ['', ...CONTRATOS]), m = sel('m', 'Modalidade', ['', ...MODOS]);
  const list = h('div');
  const draw = () => {
    const s = q.value.trim().toLowerCase(), ct = t.querySelector('select').value, md = m.querySelector('select').value;
    const r = vs.filter(v => (!s || `${v.title} ${v.funcao} ${v.company_name} ${v.location}`.toLowerCase().includes(s)) && (!ct || v.contract_type === ct) && (!md || v.work_mode === md));
    list.replaceChildren(...(r.length ? r.map(v => card(v, { favs, apps })) : [h('p', {}, 'Nenhuma vaga encontrada.')]));
  };
  [q, t, m].forEach(x => x.addEventListener('input', draw)); draw();
  return h('div', {}, h('h2', {}, 'Oportunidades de estágio e emprego'), h('div', { class: 'card' }, q, t, m), list);
}
 
async function minhas(table, title) {
  const { data: rows } = await sb.from(table).select('vacancy_id, vacancies(*)').order('created_at', { ascending: false });
  const list = (rows || []).filter(r => r.vacancies).map(r => card(r.vacancies, {
    extra: h('button', { class: 'alt', onclick: async () => { await sb.from(table).delete().eq('vacancy_id', r.vacancy_id).eq('candidate_id', me.id); route(); } }, table === 'applications' ? 'Retirar candidatura' : 'Remover')
  }));
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
  const tipo = h('select', { name: 'role' }, h('option', { value: 'candidate' }, 'Sou candidato'), h('option', { value: 'company' }, 'Sou empresa'));
  const co = h('div', { hidden: '' }, f('Razão social', 'company_social_reason'), f('CNPJ', 'cnpj', 'text', '', { inputmode: 'numeric', maxlength: '18' }));
  tipo.onchange = () => co.hidden = tipo.value !== 'company';
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault(); const d = data(form), c = d.role === 'company';
      if (d.password.length < 8) return say('A senha precisa ter ao menos 8 caracteres.', 1);
      if (c && (!d.company_social_reason || !okCNPJ(d.cnpj))) return say('Informe a razão social e um CNPJ válido.', 1);
      const { data: r, error } = await sb.auth.signUp({ email: d.email, password: d.password, options: { data: { role: d.role, name: d.name, phone: d.phone, company_social_reason: c ? d.company_social_reason : null, cnpj: c ? digits(d.cnpj) : null } } });
      if (error) return say('Não foi possível criar a conta: ' + error.message, 1);
      say(r.session ? 'Conta criada! Complete seu cadastro.' : 'Confirme seu e-mail para entrar.');
      location.hash = r.session ? '#/perfil' : '#/entrar';
    }
  }, h('h2', {}, 'Criar conta'), h('label', {}, 'Tipo de conta', tipo), f('Nome completo (empresa: nome do responsável)', 'name', 'text', '', { required: '' }), f('Telefone', 'phone', 'tel', '', { required: '' }),
    f('E-mail', 'email', 'email', '', { required: '', autocomplete: 'email' }), f('Senha (mín. 8)', 'password', 'password', '', { required: '', minlength: '8', autocomplete: 'new-password' }), co,
    h('p', {}, 'Depois de entrar, você completa o restante dos dados na aba Perfil.'), h('button', {}, 'Cadastrar'));
  return form;
}
 
function items(table, title, fields) {
  const list = h('div');
  const load = async () => {
    const { data: rows } = await sb.from(table).select('*').eq('user_id', me.id).order('created_at');
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
 
function curriculo() {
  const inp = h('input', { type: 'file', accept: '.txt,.pdf,text/plain,application/pdf' });
  const btn = h('button', {
    type: 'button', onclick: async () => {
      const file = inp.files[0]; if (!file) return say('Escolha um arquivo.', 1);
      const ext = file.name.split('.').pop().toLowerCase();
      if (!['txt', 'pdf'].includes(ext)) return say('Envie um arquivo .txt ou .pdf.', 1);
      if (file.size > 1048576) return say('O arquivo deve ter no máximo 1 MB.', 1);
      const path = `${me.id}/curriculo.${ext}`;
      const { error } = await sb.storage.from('curriculos').upload(path, file, { upsert: true, contentType: ext === 'pdf' ? 'application/pdf' : 'text/plain' });
      if (error) return say('Falha ao enviar o currículo.', 1);
      if (me.resume_path && me.resume_path !== path) await sb.storage.from('curriculos').remove([me.resume_path]);
      const r = await sb.from('profiles').update({ resume_path: path }).eq('id', me.id);
      if (r.error) return say('Falha ao salvar o currículo.', 1);
      say('Currículo anexado!'); boot();
    }
  }, 'Enviar currículo');
  return h('section', { class: 'card' }, h('h3', {}, 'Currículo (.txt ou .pdf, até 1 MB)'),
    h('p', {}, me.resume_path ? 'Currículo anexado. ' : 'Nenhum currículo anexado. ', me.resume_path && h('button', { type: 'button', class: 'alt', onclick: () => openResume(me.resume_path) }, 'Ver/baixar')), inp, ' ', btn);
}
 
function perfil() {
  const r = role(), p = me.priv;
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault(); const d = data(form);
      if (r === 'candidate' && !okCPF(d.cpf)) return say('CPF inválido.', 1);
      if (r === 'candidate' && (!d.birth_date || d.birth_date > today())) return say('Data de nascimento inválida.', 1);
      if (r === 'company' && !okCNPJ(d.cnpj)) return say('CNPJ inválido.', 1);
      const prof = { name: d.name.trim(), phone: d.phone.trim(), ...(r === 'candidate' ? { school: d.school.trim() } : {}), ...(r === 'company' ? { company_social_reason: d.company_social_reason.trim(), cnpj: digits(d.cnpj) } : {}) };
      const a = await sb.from('profiles').update(prof).eq('id', me.id);
      const b = r === 'admin' ? {} : await sb.from('dados_pessoais').upsert({ id: me.id, address: d.address.trim(), cpf: r === 'candidate' ? digits(d.cpf) : null, birth_date: r === 'candidate' ? d.birth_date : null });
      if (a.error || b.error) return say('Erro ao salvar. Confira os dados.', 1);
      say('Perfil salvo!'); boot();
    }
  }, h('h2', {}, 'Meu perfil'), h('p', {}, `Conta: ${ROLE[r]} · ${me.email}`), !me.complete && h('p', {}, '⚠️ Preencha todos os campos para liberar o restante do site.'),
    f(r === 'company' ? 'Responsável (nome completo)' : 'Nome completo', 'name', 'text', me.name, { required: '' }), f('Telefone para contato', 'phone', 'tel', me.phone, { required: '' }),
    ...(r === 'candidate' ? [f('CPF', 'cpf', 'text', p.cpf, { required: '', inputmode: 'numeric', maxlength: '14' }), f('Data de nascimento', 'birth_date', 'date', p.birth_date, { required: '', max: today() }),
      f('Endereço', 'address', 'text', p.address, { required: '', maxlength: '250' }), f('Onde estuda (instituição e curso)', 'school', 'text', me.school, { required: '', maxlength: '150' })]
      : r === 'company' ? [f('Razão social', 'company_social_reason', 'text', me.company_social_reason, { required: '' }), f('CNPJ', 'cnpj', 'text', me.cnpj, { required: '', inputmode: 'numeric', maxlength: '18' }),
        f('Local da empresa (endereço)', 'address', 'text', p.address, { required: '', maxlength: '250' })] : []),
    h('button', {}, 'Salvar'));
  return h('div', {}, form, ...(r === 'candidate' ? [curriculo(),
    items('experiences', 'Experiências', [['title', 'Cargo'], ['company_name', 'Empresa'], ['period', 'Período'], ['work_mode', 'Modalidade']]),
    items('educations', 'Formação', [['degree', 'Curso'], ['institution', 'Instituição'], ['period', 'Período']])] : []));
}
 
function publicar() {
  const adm = role() === 'admin';
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault(); const d = data(form);
      const min = d.salary_min === '' ? null : +d.salary_min, max = d.salary_max === '' ? null : +d.salary_max;
      if (min != null && max != null && min > max) return say('O salário mínimo não pode ser maior que o máximo.', 1);
      const { error } = await sb.from('vacancies').insert({ ...d, salary_min: min, salary_max: max, company_name: adm ? d.company_name.trim() : (me.company_social_reason || me.name) });
      if (error) return say('Erro ao publicar a vaga.', 1);
      say('Vaga publicada!'); location.hash = adm ? '#/admin' : '#/painel';
    }
  }, h('h2', {}, 'Publicar vaga'), adm && f('Empresa', 'company_name', 'text', '', { required: '' }), f('Título da vaga', 'title', 'text', '', { required: '' }),
    f('Função que será exercida', 'funcao', 'text', '', { required: '', maxlength: '150' }), f('Horário de trabalho (ex.: seg a sex, 8h–12h)', 'schedule', 'text', '', { required: '', maxlength: '150' }),
    f('Local de trabalho', 'location', 'text', '', { required: '' }), sel('contract_type', 'Contrato', CONTRATOS), sel('work_mode', 'Modalidade', MODOS),
    f('Salário/bolsa mínimo (R$)', 'salary_min', 'number', '', { min: '0', step: '0.01' }), f('Salário/bolsa máximo (R$)', 'salary_max', 'number', '', { min: '0', step: '0.01' }),
    h('label', {}, 'Requisitos', h('textarea', { name: 'requirements', required: '', maxlength: '2000', rows: '4' })), f('Prazo de inscrição', 'deadline', 'date', '', { required: '', min: today() }), h('button', {}, 'Publicar'));
  return form;
}
 
async function painel() {
  const { data: vs } = await sb.from('vacancies').select('*, applications(count)').eq('company_id', me.id).order('created_at', { ascending: false });
  const cards = (vs || []).map(v => {
    const box = h('div'), n = v.applications?.[0]?.count ?? 0;
    const b = h('button', {
      class: 'alt', onclick: async () => {
        if (box.childElementCount) return box.replaceChildren();
        const { data: cs } = await sb.from('applications').select('profiles(name,email,phone,school,resume_path)').eq('vacancy_id', v.id);
        const ps = (cs || []).map(c => c.profiles).filter(Boolean);
        box.replaceChildren(...(ps.length ? ps.map(p => h('div', { class: 'row' }, `${p.name} · ${p.school || '—'} · ${p.email} · ${p.phone}`, p.resume_path && h('button', { class: 'alt', onclick: () => openResume(p.resume_path) }, 'Currículo'))) : [h('p', {}, 'Sem candidatos ainda.')]));
      }
    }, `Candidatos (${n})`);
    const del = h('button', { class: 'alt', onclick: async () => { if (confirm('Excluir esta vaga?')) { await sb.from('vacancies').delete().eq('id', v.id); route(); } } }, 'Excluir');
    return h('div', {}, card(v, { extra: h('span', {}, b, ' ', del, ` 👁 ${v.views_count}`) }), box);
  });
  return h('div', {}, h('h2', {}, 'Minhas vagas'), cards.length ? cards : h('p', {}, 'Você ainda não publicou vagas.'));
}
 
async function admin() {
  const [{ data: us }, { data: vs }] = await Promise.all([sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(200), sb.from('vacancies').select('*').order('created_at', { ascending: false }).limit(200)]);
  const users = (us || []).map(u => {
    const box = h('div');
    const det = h('button', {
      class: 'alt', onclick: async () => {
        if (box.childElementCount) return box.replaceChildren();
        const { data: p } = await sb.from('dados_pessoais').select('*').eq('id', u.id).maybeSingle();
        box.replaceChildren(h('p', {}, [`Telefone: ${u.phone || '-'}`, `CPF: ${p?.cpf || '-'}`, `Nascimento: ${p?.birth_date || '-'}`, `Endereço: ${p?.address || '-'}`, `Estuda: ${u.school || '-'}`, u.cnpj && `CNPJ: ${u.cnpj}`, u.company_social_reason && `Razão social: ${u.company_social_reason}`].filter(Boolean).join(' · ')),
          u.resume_path && h('button', { class: 'alt', onclick: () => openResume(u.resume_path) }, 'Currículo'));
      }
    }, 'Detalhes');
    const blk = h('button', {
      class: 'alt', onclick: async () => {
        if (u.id === me.id) return say('Você não pode bloquear a si mesmo.', 1);
        const { error } = await sb.from('profiles').update({ active: !u.active }).eq('id', u.id);
        error ? say('Erro ao alterar a conta.', 1) : route();
      }
    }, u.active ? 'Bloquear' : 'Desbloquear');
    return h('div', { class: 'card' }, h('div', {}, `${u.name || '(sem nome)'} · ${ROLE[u.role]} · ${u.email}${u.active ? '' : ' · BLOQUEADO'}`), h('div', { class: 'actions' }, det, blk), box);
  });
  const vlist = (vs || []).map(v => card(v, { extra: h('button', { class: 'alt', onclick: async () => { if (confirm('Excluir esta vaga?')) { await sb.from('vacancies').delete().eq('id', v.id); route(); } } }, 'Excluir') }));
  return h('div', {}, h('h2', {}, 'Administração'), h('h3', {}, `Contas (${users.length})`), users, h('h3', {}, `Vagas (${vlist.length})`), h('p', {}, h('a', { href: '#/publicar' }, '+ Nova vaga')), vlist);
}
 
sb.auth.onAuthStateChange(() => setTimeout(boot, 0)); // setTimeout evita deadlock dentro do callback
window.addEventListener('hashchange', route);
 
