import { expect, it } from 'vitest';
import { workspaceWriteArgsSchema } from './workspace';
const base={path:'draft.md',mime:'text/markdown',expected_revision:1} as const;
it('workspace write admits exactly one bounded literal edit or full text representation',()=>{
 expect(workspaceWriteArgsSchema.safeParse({...base,edits:[{before:'noon',after:'14:00'}]}).success).toBe(true);
 expect(workspaceWriteArgsSchema.safeParse({...base,edits:[{before:'remove',after:''}]}).success).toBe(true);
 for(const args of [{...base},{...base,text:'both',edits:[{before:'one',after:'two'}]},{...base,expected_revision:0,edits:[{before:'one',after:'two'}]},{...base,edits:[]},{...base,edits:[{before:'',after:'insert'}]},{...base,edits:[{before:'one',after:'two',regex:true}]},{...base,edits:[{before:'one',after:'two'}],ownerId:'foreign'},{...base,text:'one',file_id:'forged'},{...base,edits:Array.from({length:21},()=>({before:'one',after:'two'}))},{...base,edits:[{before:'é'.repeat(16001),after:''}]}])expect(workspaceWriteArgsSchema.safeParse(args).success).toBe(false);
});
