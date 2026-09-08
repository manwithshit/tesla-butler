// Parse only explicit receipt fields, never a bare number or a default-rate command.
export function parseReceiptText(text, now = new Date()) {
  const input=String(text || '').trim();
  if (/[?？]|默认|每度|电价|单价/.test(input)) return null;
  const patch={};
  const collect=(pattern,key,max)=>{
    const values=[...input.matchAll(pattern)].map(m=>Number(m[1]));
    if(!values.length)return;
    if(new Set(values).size!==1 || !Number.isFinite(values[0]) || values[0]<0 || values[0]>max
      || (key==='energy_kwh' && values[0]===0)) throw new Error('请每次只描述一笔账单，并明确实付金额（元）和充电电量（度）。');
    patch[key]=values[0];
  };
  collect(/(?:实付(?:金额)?|金额|花了?|支付了?|付了?)\s*(?:应该是|改为|改成|是|为|[:：])?\s*(-?\d+(?:\.\d+)?)\s*(?:元|块)?/g,'amount_cny',10000);
  collect(/(?:充电电量|电量|充了?)\s*(?:应该是|改为|改成|是|为|[:：])?\s*(-?\d+(?:\.\d+)?)\s*(?:度|kwh)/gi,'energy_kwh',500);
  const date=input.match(/\b(20\d{2})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if(date){
    const iso=`${date[1]}-${date[2]}-${date[3]}`;
    const d=new Date(`${iso}T00:00:00Z`);
    if(!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10)!==iso || Number(date[4]||0)>23 || Number(date[5]||0)>59)throw new Error('日期无效，请使用 YYYY-MM-DD HH:mm。');
    patch.charged_at=iso+(date[4]?` ${date[4]}:${date[5]}`:'');
  }else if(/今天|昨天|前天/.test(input)){
    const offset=input.includes('前天')?2:input.includes('昨天')?1:0;
    patch.charged_at=new Date(new Date(now).getTime()+8*3600000-offset*86400000).toISOString().slice(0,10);
  }
  return Object.keys(patch).length ? patch : null;
}
