import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {scanLedger,hourlyPrices} from './pool-ledger.mjs';

const output=process.argv[2];
if(!output)throw Error('Informe o arquivo de saída');
let previous;
try{previous=JSON.parse(await readFile(output,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
async function rpc(method,params){
  let failure;
  for(const host of ['https://api.mainnet-beta.solana.com','https://solana-rpc.publicnode.com']){
    try{
      const response=await fetch(host,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw Error('RPC HTTP '+response.status);
      const body=await response.json();
      if(body.error)throw Error(body.error.message);
      return body.result;
    }catch(error){failure=error;}
  }
  throw failure;
}
const ledger=await scanLedger(previous,rpc,hourlyPrices);
await mkdir(dirname(output),{recursive:true});
await writeFile(output+'.tmp',JSON.stringify(ledger));
await rename(output+'.tmp',output);
console.log(JSON.stringify({updatedAt:ledger.updatedAt,events:ledger.events.length,summary:ledger.summary}));
