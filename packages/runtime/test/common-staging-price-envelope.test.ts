import {expect,it} from 'vitest';
import {commonLunaEnvelope,commonLunaFullContextEnvelope,commonCloudflareEnvelope,COMMON_PRICE_SOURCES} from '../src/channels/common-staging-price-envelope';
it('reserves highest input category including all premiums and output hidden tokens without cache discount',()=>{
 expect(commonLunaEnvelope(1000,4096)).toBe(7309);
 expect(commonLunaEnvelope(1_050_000,4096)).toBe(584259);
 expect(commonLunaFullContextEnvelope(4096)).toBe(584259);
 expect(commonLunaEnvelope(0,1)).toBe(2);
 expect(Object.isFrozen(COMMON_PRICE_SOURCES)).toBe(true);
});
it('browser marginal envelope covers nearest-hour rounding and every allocation/day peak regardless of allowances',()=>{
 expect(commonCloudflareEnvelope(120000,1,30)).toBe(156667);
 expect(commonCloudflareEnvelope(120000,2,30)).toBe(223334);
 expect(commonCloudflareEnvelope(3600001,2,30)).toBe(313334);
 expect(commonCloudflareEnvelope(120000,1,31)).toBe(154517);
});
it('rejects absent/negative/fractional/unbounded pricing inputs',()=>{
 for(const input of [-1,NaN,Infinity,1.5,1_050_001])expect(()=>commonLunaEnvelope(input,4096)).toThrow();
 for(const output of [0,NaN,128001])expect(()=>commonLunaEnvelope(1,output)).toThrow();
 for(const [ms,day,cycle] of [[0,1,30],[NaN,1,30],[1,0,30],[1,1,0],[1,1,366.5],[1,367,30]])expect(()=>commonCloudflareEnvelope(ms!,day!,cycle!)).toThrow();
});
