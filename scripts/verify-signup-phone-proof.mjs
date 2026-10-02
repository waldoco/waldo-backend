import { readFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const root=new URL('../',import.meta.url).pathname;
if(process.env.DOCKER_HOST||process.env.DOCKER_CONTEXT)throw Error('endpoint overrides refused');
const ctx=spawnSync('docker',['context','inspect'],{encoding:'utf8'});
if(ctx.status!==0)throw Error('local Docker unavailable');
const endpoint=JSON.parse(ctx.stdout)[0]?.Endpoints?.docker?.Host;
if(!endpoint?.startsWith('unix:///')||new URL(endpoint).hostname)throw Error('local Unix socket required');
const name='waldo-phone-proof-'+randomUUID(),net=name+'-net',label='waldo.phone-proof='+name;
const image='public.ecr.aws/supabase/postgres@sha256:80d7b27c3e8d77cfa7226eee9508671796da214781ff15a35b3670d7ad5ee453';
const authImage='public.ecr.aws/supabase/gotrue@sha256:b252efb680be37d4a8bf77c210cf0439c19b63a4b51929233a65dd101d25bdab';
const run=(args,input)=>{const r=spawnSync('docker',['--host',endpoint,...args],{input,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr||'fixture command failed');return r.stdout;};
const sql=input=>run(['exec','-i','--user','postgres',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-At'],input);
try {
 run(['network','create','--internal','--label',label,net]);
 run(['run','--pull=never','-d','--name',name,'--label',label,'--network',net,'--user','postgres','-e','POSTGRES_PASSWORD=synthetic-disposable-only',image]);
 const until=Date.now()+60000;
 while(spawnSync('docker',['--host',endpoint,'exec','--user','postgres',name,'pg_isready','-h','127.0.0.1','-U','postgres']).status!==0){if(Date.now()>until)throw Error('startup timeout');await new Promise(r=>setTimeout(r,100));}
 run(['exec','-i','--user','postgres',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],"alter role supabase_auth_admin password 'synthetic-disposable-only';");
 run(['run','--pull=never','--rm','--name',name+'-auth','--label',label,'--network',net,'-e','GOTRUE_DB_DRIVER=postgres','-e','GOTRUE_DB_DATABASE_URL=postgres://supabase_auth_admin:synthetic-disposable-only@'+name+':5432/postgres','-e','GOTRUE_SITE_URL=http://fixture.invalid','-e','API_EXTERNAL_URL=http://fixture.invalid','-e','GOTRUE_JWT_SECRET=synthetic-disposable-only-jwt-secret',authImage,'auth','migrate']);
 const config=JSON.parse(run(['inspect',name]))[0];
 if(!JSON.parse(run(['network','inspect',net]))[0].Internal||Object.keys(config.HostConfig.PortBindings??{}).length||config.Config.User!=='postgres')throw Error('isolation not proved');
 console.log('PASS local isolated database; internal network; no published ports; pinned images; synthetic credentials');
 for(const file of readdirSync(join(root,'supabase/migrations')).filter(f=>f.endsWith('.sql')).sort()){sql(readFileSync(join(root,'supabase/migrations',file)));console.log('PASS migration '+file);}
 sql(readFileSync(join(root,'supabase/migrations/20261002161000_waldo_signup_phone_proof.sql')));
 console.log('PASS additive migration replay');
 for(const file of ['waldo_console_auth.sql','waldo_invite_chain.sql','waldo_open_signup.sql','waldo_signup_phone_proof.sql']){const out=sql(readFileSync(join(root,'supabase/tests',file)));console.log('TEST '+file+'\n'+out);if(out.includes('not ok')||!out.includes('1..'))throw Error('pgTAP failed '+file);}

 sql(`delete from vault.secrets where name='waldo_router_hmac'; select vault.create_secret('synthetic-race-router','waldo_router_hmac');
 create function public.phone_fixture_at() returns bigint language sql as $$select floor(extract(epoch from clock_timestamp()))::bigint$$;
 create function public.phone_fixture_call(action text,payload jsonb) returns jsonb language sql as $$select waldo.signup_phone_transition(action,payload::text,public.phone_fixture_at(),encode(extensions.hmac(public.phone_fixture_at()::text||'.phoneproof.'||action||'.'||payload::text,'synthetic-race-router','sha256'),'hex'))$$;
 insert into auth.users(id,email,email_confirmed_at) values('40000000-0000-0000-0000-000000000001','race@test.invalid',now());
 insert into waldo.invites(code_hash,email,expires_at) values(repeat('f',64),'race@test.invalid',now()+interval '1 day');
 create table public.phone_fixture_input(p jsonb);
 insert into public.phone_fixture_input values(jsonb_build_object('attempt','50000000-0000-0000-0000-000000000001','authUser','40000000-0000-0000-0000-000000000001','email','race@test.invalid','inviteHash',repeat('f',64),'phone','+919876540001','service','VA'||repeat('b',32),'expires',public.phone_fixture_at()+899));
 select public.phone_fixture_call('reserve_send',p||jsonb_build_object('operation','60000000-0000-0000-0000-000000000001')) from public.phone_fixture_input;
 select public.phone_fixture_call('finish_send',p||jsonb_build_object('operation','60000000-0000-0000-0000-000000000001','outcome','pending','sid','VE'||repeat('c',32))) from public.phone_fixture_input;
 select public.phone_fixture_call('reserve_check',p||jsonb_build_object('operation','60000000-0000-0000-0000-000000000002')) from public.phone_fixture_input;
 update waldo.signup_phone_challenges set phone_expires=clock_timestamp()+interval '1.5 seconds' where email='race@test.invalid';`);
 const startSQL=input=>{
  const child=spawn('docker',['--host',endpoint,'exec','-i','--user','postgres',name,'psql','-X','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres','-At']);
  let output='',err='',readyResolve; const ready=new Promise(resolve=>{readyResolve=resolve;});
  child.stdout.on('data',bytes=>{output+=bytes.toString();if(output.includes('LOCKED'))readyResolve();});child.stderr.on('data',bytes=>{err+=bytes.toString();});
  const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve(output):reject(Error(err||'concurrent SQL failed')));});child.stdin.end(input);return {ready,done};
 };
 const lock=startSQL("begin; select id from waldo.signup_phone_budget where id for update; select 'LOCKED'; select pg_sleep(2.5); commit;");
 await Promise.race([lock.ready,lock.done.then(()=>{throw Error('lock marker absent');})]);
 const finish=startSQL("select public.phone_fixture_call('finish_check',p||jsonb_build_object('operation','60000000-0000-0000-0000-000000000002','outcome','approved','sid','VE'||repeat('c',32)))->>'kind' from public.phone_fixture_input;");
 const [_,finished]=await Promise.all([lock.done,finish.done]);
 if(finished.trim()!=='expired')throw Error('expiry after lock wait must deny approval; got '+finished.trim());
 if(sql("select count(*) from waldo.signup_phone_challenges where email='race@test.invalid' and approved_at is not null;").trim()!=='0')throw Error('late approval persisted');
 console.log('PASS concurrent late approval after budget lock wait is expired; no proof persisted');
 sql("update public.phone_fixture_input set p=p||jsonb_build_object('attempt','50000000-0000-0000-0000-000000000002','phone','+919876540002','expires',public.phone_fixture_at()+2);");
 const nextLock=startSQL("begin; select id from waldo.signup_phone_budget where id for update; select 'LOCKED'; select pg_sleep(2.5); commit;");
 await Promise.race([nextLock.ready,nextLock.done.then(()=>{throw Error('lock marker absent');})]);
 const reserve=startSQL("select public.phone_fixture_call('reserve_send',p||jsonb_build_object('operation','60000000-0000-0000-0000-000000000003'))->>'kind' from public.phone_fixture_input;");
 const [,reserved]=await Promise.all([nextLock.done,reserve.done]);
 if(reserved.trim()!=='expired')throw Error('signup expiry after lock wait must refuse reserve; got '+reserved.trim());
 console.log('PASS concurrent send reservation after signup deadline refuses provider work');
 sql(`insert into auth.users(id,email,email_confirmed_at) values('40000000-0000-0000-0000-000000000002','race2@test.invalid',now());
 insert into waldo.invites(code_hash,email,expires_at) values(repeat('e',64),'race2@test.invalid',now()+interval '1 day');
 create table public.phone_fixture_racers(n integer,p jsonb);
 insert into public.phone_fixture_racers values(1,(select p||jsonb_build_object('attempt','50000000-0000-0000-0000-000000000003','phone','+919876540003','expires',public.phone_fixture_at()+899) from public.phone_fixture_input));
 insert into public.phone_fixture_racers values(2,(select p||jsonb_build_object('attempt','50000000-0000-0000-0000-000000000004','authUser','40000000-0000-0000-0000-000000000002','email','race2@test.invalid','inviteHash',repeat('e',64)) from public.phone_fixture_racers where n=1));`);
 const races=[1,2].map(n=>startSQL("select public.phone_fixture_call('reserve_send',p||jsonb_build_object('operation','60000000-0000-0000-0000-000000000004'))->>'kind' from public.phone_fixture_racers where n="+n+";"));
 const raced=(await Promise.all(races.map(r=>r.done))).map(r=>r.trim()).sort();
 if(JSON.stringify(raced)!==JSON.stringify(['denied','reserved']))throw Error('parallel recipient reservation failed '+JSON.stringify(raced));
 console.log('PASS two concurrent identities: one recipient reservation, one denial');

} finally {
 const containers=run(['ps','-a','--filter','label='+label,'--format','{{.ID}}']).trim().split('\n').filter(Boolean);
 for(const id of containers)run(['rm','-f','-v',id]);
 const networks=run(['network','ls','--filter','label='+label,'--format','{{.ID}}']).trim().split('\n').filter(Boolean);
 for(const id of networks)run(['network','rm',id]);
 if(run(['ps','-a','--filter','label='+label,'--format','{{.ID}}']).trim()||run(['network','ls','--filter','label='+label,'--format','{{.ID}}']).trim())throw Error('cleanup failed');
 console.log('PASS disposal; zero owned containers/networks');
}
