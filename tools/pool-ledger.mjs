export const POSITION = '8dqY7JSPJxMcH7qQ5CYohXJHMR382igki1FDcJLbV325';
export const POOL = 'B5EwJVDuAauzUEEdwvbuXzbFFgEYnUqqS37TUM1c4PQA';
// Four finalized deposits completed this position's opening at 23:18:57 JST.
export const OPENING_END = 1795616337;
export const REPORTED_EXIT = {"id":"user-reported-net-exit-8dqY7JSP-20261126","time":1795624470,"timeSource":"Horário do registro; saída informada pelo usuário","baseUsd":4100,"proceedsUsd":4339,"pnlUsd":239,"pnlPercent":5.829268292682928,"stageCostUsd":4319.06,"stagePnlUsd":19.9399999999996,"unpriced":0,"source":"user-reported-net","valuation":"Saída líquida informada pelo usuário: US$ 4.339; taxas já incluídas"};
export const PAST_POSITIONS = [{position:'FtWGNzUnykfnNKfVrLvu9k9BCNBQTv66rKgGXwGCm33M',netExitUsd:4320,baseUsd:4100,pnlUsd:220,pnlPercent:220/4100*100,source:'user-reported-net',archive:'data/pool-history/FtWGNzUnykfnNKfVrLvu9k9BCNBQTv66rKgGXwGCm33M.json'}];
const PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
const SOL = 'So11111111111111111111111111111111111111112';
const BTC = '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh';
const METHODS = {
  '46,156,243,118,13,205,251,178': ['deposit',3,7,8],
  '133,29,89,223,69,238,176,10': ['deposit',5,11,12],
  '239,251,9,124,210,198,53,43': ['deposit',5,11,12],
  '160,38,208,111,104,91,44,1': ['withdrawal',3,7,8],
  '58,127,188,62,79,82,196,96': ['withdrawal',5,11,12],
  '164,152,207,99,30,186,19,182': ['fees',2,5,7],
  '207,117,95,191,229,180,226,15': ['fees',2,7,9]
};

function decode58(value) {
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let number=0n;
  for(const char of value){const digit=alphabet.indexOf(char);if(digit<0)throw Error('Base58 inválida');number=number*58n+BigInt(digit);}
  const bytes=[];
  while(number){bytes.unshift(Number(number%256n));number/=256n;}
  for(const char of value){if(char!=='1')break;bytes.unshift(0);}
  return bytes;
}

export function decodeEvents(tx,signature) {
  if(!tx?.meta || tx.meta.err)return [];
  const message=tx.transaction.message;
  const mintByAccount=new Map();
  for(const balance of [...(tx.meta.preTokenBalances||[]),...(tx.meta.postTokenBalances||[])]){
    const account=message.accountKeys[balance.accountIndex];
    mintByAccount.set(typeof account==='string'?account:account.pubkey,balance.mint);
  }
  const events=[];
  message.instructions.forEach((outer,index)=>{
    const inner=tx.meta.innerInstructions?.find(group=>group.index===index)?.instructions||[];
    const instructions=[{...outer,stackHeight:1},...inner];
    instructions.forEach((instruction,ordinal)=>{
      if(instruction.programId!==PROGRAM||!instruction.data)return;
      const method=METHODS[decode58(instruction.data).slice(0,8).join(',')];
      const accounts=instruction.accounts||[];
      if(!method||accounts[0]!==POOL||accounts[method[1]]!==POSITION)return;
      const [kind,,solIndex,btcIndex]=method;
      const vaults=[accounts[solIndex],accounts[btcIndex]];
      const raw=[0n,0n];
      for(let n=ordinal+1;n<instructions.length;n++){
        const child=instructions[n];
        if(child.stackHeight && child.stackHeight<=instruction.stackHeight)break;
        const parsed=child.parsed;
        if(!['transfer','transferChecked'].includes(parsed?.type))continue;
        const info=parsed.info;
        const vault=kind==='deposit'?info.destination:info.source;
        const token=vaults.indexOf(vault);
        if(token<0)continue;
        const mint=info.mint||mintByAccount.get(vault);
        if(mint && mint!==[SOL,BTC][token])throw Error('Mint inesperado na transferência');
        raw[token]+=BigInt(info.tokenAmount?.amount??info.amount);
      }
      if(raw.every(amount=>amount===0n))return;
      events.push({id:signature+':'+index+':'+ordinal,signature,slot:tx.slot,time:tx.blockTime,
        order:index*10000+ordinal,kind,sol:Number(raw[0])/1e9,btc:Number(raw[1])/1e8,
        transactionFeeSol:tx.meta.fee/1e9});
    });
  });
  return events;
}

export function summarize(events) {
  const result={collectedSol:0,collectedBtc:0,collectedUsd:0,depositedSol:0,depositedBtc:0,
    depositedUsd:0,withdrawnUsd:0,netFlowUsd:0,reinvestmentCompatibleUsd:0,unpriced:0};
  let firstDeposit=true,availableFees=0;
  for(const event of [...events].sort((a,b)=>a.slot-b.slot||a.order-b.order||a.id.localeCompare(b.id))){
    if(event.kind==='deposit'&&(firstDeposit||event.time<=OPENING_END)){firstDeposit=false;continue;}
    const priced=Number.isFinite(event.usd);
    if(!priced)result.unpriced++;
    const usd=priced?event.usd:0;
    if(event.kind==='fees'){
      result.collectedSol+=event.sol;result.collectedBtc+=event.btc;result.collectedUsd+=usd;
      availableFees+=usd;result.netFlowUsd+=usd;
    }else if(event.kind==='withdrawal'){
      result.withdrawnUsd+=usd;result.netFlowUsd+=usd;
    }else if(event.kind==='deposit'){
      result.depositedSol+=event.sol;result.depositedBtc+=event.btc;result.depositedUsd+=usd;
      const possible=Math.min(availableFees,usd);
      result.reinvestmentCompatibleUsd+=possible;availableFees-=possible;result.netFlowUsd-=usd;
    }
  }
  return result;
}

export function recordClosure(previous,events,summary,account) {
  if(REPORTED_EXIT){
    const closures=(previous?.closures||[]).filter(item=>item.id!==REPORTED_EXIT.id);
    closures.push(REPORTED_EXIT);
    return {status:'closed',closure:REPORTED_EXIT,closures};
  }
  const withdrawals=events.filter(event=>event.kind==='withdrawal');
  const last=withdrawals.at(-1);
  let empty=account===null;
  if(account?.data?.[1]==='base64'){
    const bytes=Uint8Array.from(atob(account.data[0]),char=>char.charCodeAt(0));
    if(bytes.length<88)throw Error('Conta de posição incompleta');
    empty=bytes.slice(72,88).every(byte=>byte===0);
  }
  const closures=[...(previous?.closures||[])];
  if(!empty||!last)return {status:'open',closure:null,closures};
  const closure={id:last.id,time:last.time,signature:last.signature,baseUsd:4100,
    proceedsUsd:summary.netFlowUsd,pnlUsd:summary.netFlowUsd-4100,
    pnlPercent:(summary.netFlowUsd/4100-1)*100,unpriced:summary.unpriced,
    valuation:'Tokens retirados; USD estimado pela referência horária, não venda confirmada'};
  const index=closures.findIndex(item=>item.id===closure.id);
  if(index<0)closures.push(closure);else closures[index]=closure;
  return {status:'closed',closure,closures};
}

export async function scanLedger(previous,rpc,priceAt) {
  const existing=previous?.position===POSITION?previous:{position:POSITION,events:[],signatures:[],prices:{}};
  const known=new Set(existing.signatures||[]),pending=[];
  let before;
  for(let page=0;page<50;page++){
    const rows=await rpc('getSignaturesForAddress',[POSITION,{limit:100,commitment:'finalized',...(before?{before}:{})}]);
    let found=false;
    for(const row of rows){if(known.has(row.signature)){found=true;break;}pending.push(row);}
    if(found||rows.length<100)break;
    if(page===49)throw Error('Histórico excede limite; continuar a paginação antes de salvar');
    before=rows.at(-1).signature;
  }
  const eventMap=new Map(existing.events.map(event=>[event.id,event]));
  const signatures=[...(existing.signatures||[])];
  for(const row of pending.reverse()){
    if(!row.err){
      const tx=await rpc('getTransaction',[row.signature,{encoding:'jsonParsed',commitment:'finalized',maxSupportedTransactionVersion:0}]);
      if(!tx)throw Error('Transação confirmada ainda indisponível; nova tentativa na próxima leitura');
      for(const event of decodeEvents(tx,row.signature))eventMap.set(event.id,event);
    }
    signatures.push(row.signature);
  }
  const events=[...eventMap.values()].sort((a,b)=>a.slot-b.slot||a.order-b.order||a.id.localeCompare(b.id));
  const prices={...existing.prices};
  for(const event of events){
    if(event.kind==='deposit'&&event.time<=OPENING_END)continue;
    if(Number.isFinite(event.usd))continue;
    try{
      const hour=Math.floor(event.time/3600)*3600;
      if(!prices[hour])prices[hour]=await priceAt(hour);
      const p=prices[hour];
      if(!(p.sol>0&&p.btc>0))throw Error('Preço histórico indisponível');
      event.usd=event.sol*p.sol+event.btc*p.btc;
      event.valuation='Referência horária USD; estimativa';
    }catch(error){event.priceError=error.message;}
  }
  const summary=summarize(events);
  const account=await rpc('getAccountInfo',[POSITION,{encoding:'base64',commitment:'finalized'}]);
  const closure=recordClosure(existing,events,summary,account.value);
  const openingEvents=events.filter(event=>event.kind==='deposit'&&event.time<=OPENING_END);
  const opening={count:openingEvents.length,sol:openingEvents.reduce((sum,event)=>sum+event.sol,0),btc:openingEvents.reduce((sum,event)=>sum+event.btc,0),signatures:openingEvents.map(event=>event.signature),time:openingEvents[0]?.time,completedAt:OPENING_END};
  return {version:3,position:POSITION,pool:POOL,updatedAt:new Date().toISOString(),events,signatures,prices,
    summary,opening,pastPositions:PAST_POSITIONS,...closure};
}

export async function hourlyPrices(hour) {
  const prices=await Promise.all(['SOL','BTC'].map(async symbol=>{
    const start=new Date(hour*1000).toISOString(),end=new Date((hour+3600)*1000).toISOString();
    const response=await fetch('https://api.exchange.coinbase.com/products/'+symbol+'-USD/candles?granularity=3600&start='+encodeURIComponent(start)+'&end='+encodeURIComponent(end),{signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw Error('Preço histórico HTTP '+response.status);
    const rows=await response.json(),row=rows.find?.(row=>row[0]===hour);
    if(!(row?.[4]>0))throw Error('Vela histórica USD indisponível');
    return Number(row[4]);
  }));
  return {sol:prices[0],btc:prices[1]};
}

