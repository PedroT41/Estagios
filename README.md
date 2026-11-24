# Estagiagros (site)

1. Crie um projeto em supabase.com → **SQL Editor** → cole e execute `schema.sql`.
2. Em **Project Settings → API**, copie a *Project URL* e a chave *anon public* para o topo de `app.js`.
   (Nunca use a chave `service_role` aqui.)
3. Em **Authentication → URL Configuration**, coloque a URL do seu GitHub Pages em *Site URL*.
4. Suba `index.html` e `app.js` para um repositório GitHub → **Settings → Pages → Deploy from branch (main, /root)**.
