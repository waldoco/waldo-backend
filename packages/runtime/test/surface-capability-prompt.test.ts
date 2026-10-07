import { expect,it } from 'vitest';
import { messagingSystemPrompt,withOwnerSkillProcedures } from '../src/prompt/messaging-behavior';
it('shared prompt describes rendered WhatsApp text callbacks, not undelivered native buttons/reactions',()=>{
 const prompt=messagingSystemPrompt(['workspace_write'],{surface:'whatsapp',delivery:{text:true,approval:'text_callback',reactions:false,attachments:false},commands:[]});
 expect(prompt).toContain('Approval delivery: text_callback');
 expect(prompt).toContain('Reactions: unavailable');
 expect(prompt).not.toContain('Connection links arrive as buttons');
 expect(prompt).not.toContain('Do it / Modify / Not now buttons');
 expect(prompt).not.toContain('owner can type /ledger');
});
it('native Telegram presentation stays distinct from common authority and task context',()=>{
 const prompt=messagingSystemPrompt([],{surface:'telegram',delivery:{text:true,approval:'native_buttons',reactions:true,attachments:false},commands:['/stop','/ledger']});
 expect(prompt).toContain('Approval delivery: native_buttons');
 expect(prompt).toContain('/ledger');
 expect(prompt).toContain('does not grant approval');
});

it('reviewed-skill safety wrapper does not restore false surface delivery promises',()=>{
 const presentation={surface:'whatsapp',delivery:{text:true,approval:'text_callback' as const,reactions:false,attachments:false},commands:[]};
 const prompt=withOwnerSkillProcedures(messagingSystemPrompt([],presentation),'Reviewed file procedure',presentation);
 expect(prompt).not.toContain('Connection links arrive as buttons');
 expect(prompt).not.toContain('Do it / Modify / Not now buttons');
 expect(prompt).toContain('Apply existing tool and approval checks');
});
