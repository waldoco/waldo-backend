import {expect,it} from 'vitest';
import {browseActArgsSchema} from './reads';
it('ordinary retained browser commands can request human login without credentials or provider bearer arguments',()=>{
 const args={url:'https://accounts.example.com/login',task:'Read my account after I sign in',session_handle:'owned-session',command:{operation:'owner_login',reason:'Please sign in to the intended account and complete MFA.'}};
 expect(browseActArgsSchema.safeParse(args).success).toBe(true);
 expect(browseActArgsSchema.safeParse({...args,command:{...args.command,password:'fictional'}}).success).toBe(false);
 expect(browseActArgsSchema.safeParse({...args,command:{operation:'resume_owner_login'}}).success).toBe(true);
});
