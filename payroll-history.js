(function(root,factory){
  'use strict';
  var api=factory(typeof module==='object'&&module.exports?require('./payroll-statement.js'):root.PayrollStatement);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PayrollHistory=api;
})(typeof window==='object'?window:globalThis,function(payroll){
  'use strict';
  function safe(n){if(!Number.isSafeInteger(n))throw new Error('Недопустимая сумма в истории выплат');return n;}
  function qty(n){if(n===null||n===''||!Number.isSafeInteger(Number(n))||Number(n)<0)throw new Error('Некорректное количество в истории выплат');return Number(n);}
  function decimal(n){return(n<0?'-':'')+Math.floor(Math.abs(n)/100)+'.'+String(Math.abs(n)%100).padStart(2,'0');}
  function day(value){var d=new Date(value);if(!value||!Number.isFinite(d.getTime()))throw new Error('Некорректная дата отметки оплаты');return new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);}
  function build(data){
    if(!Array.isArray(data.paymentEvents))return{payments:[],issues:[]};
    var operations=new Map(),balances=new Map(),seen=new Set(),entries=[],issues=[],total=0;
    data.operations.forEach(function(op){var key=JSON.stringify([op.packId,op.operationName]);if(operations.has(key))throw new Error('Повторная операция в истории выплат');operations.set(key,op);});
    var events=data.paymentEvents.slice();
    events.forEach(function(e){var id=String(e.id);if(!/^[1-9][0-9]*$/.test(id)||seen.has(id))throw new Error('Повторная или некорректная запись журнала выплат');seen.add(id);});
    events.sort(function(a,b){var x=BigInt(a.id),y=BigInt(b.id);return x<y?-1:x>y?1:0;});
    events.forEach(function(e){
      var p=e.payload||{},key=JSON.stringify([e.pack_id,p.operation]),op=operations.get(key),date=day(e.created_at);
      if(!op){if(date===data.paymentDate&&p.source!=='payroll_recovery')throw new Error('Не найден паспорт или операция из журнала оплаты: '+e.pack_id);return;}
      var before=balances.has(key)?balances.get(key):0,after,explicit=p.from_qty!==undefined;
      if(explicit){var from=qty(p.from_qty);if(balances.has(key)&&from!==before)throw new Error('Не сходится история оплаченного количества: '+e.pack_id);before=from;}
      if(e.event_type==='Оплата швее'){
        if(typeof p.paid!=='boolean')throw new Error('Не определён вид отметки оплаты: '+e.pack_id);
        after=p.paid?qty(p.qty):0;
      }else if(e.event_type==='Оплата операции'){
        if(!explicit||p.to_qty===undefined)throw new Error('Неполная история оплаты операции: '+e.pack_id);after=qty(p.to_qty);
      }else if(e.event_type==='Отмена оплаты операции')after=0;
      else throw new Error('Неизвестная запись журнала выплат');
      if(p.to_qty!==undefined&&qty(p.to_qty)!==after)throw new Error('Не сходится итог отметки оплаты: '+e.pack_id);
      balances.set(key,after);
      // A recovery entry changes the running balance at recording time, but its
      // effective payment date and immutable amount already come from its batch.
      if(p.source==='payroll_recovery')return;
      var delta=after-before;if(date!==data.paymentDate||!delta)return;
      var price=payroll.cents(p.price===undefined?op.price:p.price),amount=safe(Math.abs(delta)*price);
      entries.push({eventId:String(e.id),packId:op.packId,passport:op.passport,model:op.model,cutDate:op.cutDate,
        sewerName:p.sewerName||op.sewerName,operationName:op.operationName,qty:Math.abs(delta),direction:delta<0?-1:1,
        price:decimal(price),amount:decimal(amount),recordedAt:e.created_at});
      total=safe(total+(delta<0?-amount:amount));
    });
    operations.forEach(function(op,key){
      if((balances.get(key)||0)!==qty(op.paidQty))issues.push({sewerName:op.sewerName,model:op.model,packId:op.packId,message:'Текущая оплата не совпадает с журналом: '+op.packId+' / '+op.operationName+'. Обновите данные; если расхождение сохраняется, состав выплаты требует проверки.'});
    });
    return{payments:entries.length?[{batchId:'journal-'+data.paymentDate,paymentDate:data.paymentDate,recordedAt:'',source:'payment_history',count:entries.length,amount:decimal(total),entries:entries}]:[],issues:issues};
  }
  return{build:build};
});
