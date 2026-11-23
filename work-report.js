(function (root, factory) {
  'use strict';
  var api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else{root.WorkReport=api;root.openWorkReport=api.open;root.loadWorkReport=api.load;root.renderWorkReport=api.render;root.exportWorkReport=api.exportExcel;}
})(typeof window==='object'?window:globalThis,function(root){
  'use strict';
  function qty(value){if(value===null||value===''||!Number.isSafeInteger(Number(value))||Number(value)<0)throw new Error('Некорректное количество в остатках');return Number(value);}
  function safe(value){if(!Number.isSafeInteger(value))throw new Error('Количество превышает допустимое значение');return value;}
  function html(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function day(value){var parsed=new Date(value);return value&&Number.isFinite(parsed.getTime())?new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(parsed):'';}
  function validDate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;var d=new Date(value+'T12:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;}
  function date(value){return value?value.slice(8,10)+'.'+value.slice(5,7)+'.'+value.slice(0,4):'Не указана';}
  function compare(a,b){return String(a).localeCompare(String(b),'ru',{numeric:true});}
  function summarize(rows){
    var packs=new Map(),totals={packCount:0,packRemaining:0,operationCount:rows.length,operationRemaining:0,withoutAcceptance:0,partial:0,defects:0,warningCount:0};
    rows.forEach(function(row){packs.set(row.packId,Math.max(packs.get(row.packId)||0,row.remainingQty));totals.operationRemaining=safe(totals.operationRemaining+row.remainingQty);totals.defects=safe(totals.defects+row.defectQty);if(row.acceptedQty+row.defectQty===0)totals.withoutAcceptance++;else totals.partial++;if(row.warnings.length)totals.warningCount++;});
    totals.packCount=packs.size;packs.forEach(function(q){totals.packRemaining=safe(totals.packRemaining+q);});return totals;
  }
  function build(operations,options){
    options=options||{};
    if(!Array.isArray(operations))throw new Error('Не удалось загрузить выданную работу');
    if(options.cutFrom&&!validDate(options.cutFrom)||options.cutTo&&!validDate(options.cutTo)||options.cutFrom&&options.cutTo&&options.cutFrom>options.cutTo)throw new Error('Проверьте период кроя');
    var minDays=options.minDays==null||options.minDays===''?0:Number(options.minDays);
    if(!Number.isSafeInteger(minDays)||minDays<0)throw new Error('Укажите целое количество дней от 0');
    var now=options.now||new Date().toISOString(),today=day(now);if(!today)throw new Error('Не удалось определить дату отчёта');
    var seen=new Set(),keys=new Set(),rows=[],query=String(options.search||'').trim().toLocaleLowerCase('ru');
    operations.forEach(function(op){
      if(op.packStatus==='annulled')return;
      var id=String(op.id),key=JSON.stringify([op.packId,op.operationName]);
      if(!op.id||seen.has(id)||keys.has(key))throw new Error('Повторная операция в остатках');seen.add(id);keys.add(key);
      if(!op.packId||!op.operationName||!op.model)throw new Error('Не заполнены данные паспорта или операции');
      var issued=qty(op.issuedQty),accepted=qty(op.acceptedQty),defects=qty(op.defectQty),packQty=qty(op.packQty),processed=safe(accepted+defects),remaining=Math.max(0,issued-processed);
      if(!issued||!remaining)return;
      var cut=op.cutDate||'';if(cut&&!validDate(cut))throw new Error('Некорректная дата кроя: '+op.packId);
      var issuedDay=day(op.issuedAt),age=issuedDay?Math.max(0,Math.round((Date.parse(today+'T12:00:00Z')-Date.parse(issuedDay+'T12:00:00Z'))/86400000)):null;
      var sewer=op.sewerName||'Не назначена';
      if(options.sewer&&sewer!==options.sewer||options.model&&op.model!==options.model)return;
      if(options.cutFrom&&(!cut||cut<options.cutFrom)||options.cutTo&&(!cut||cut>options.cutTo))return;
      if(options.kind==='none'&&processed>0||options.kind==='partial'&&processed===0)return;
      if(minDays>0&&(age===null||age<minDays))return;
      if(query&&[op.packId,op.passport,op.model,op.operationName,sewer,op.size,op.color].join(' ').toLocaleLowerCase('ru').indexOf(query)<0)return;
      var warnings=[];
      if(['issued','partially_accepted'].indexOf(op.packStatus)<0)warnings.push('Статус паспорта не соответствует незавершённой операции');
      if(issued!==packQty)warnings.push('Выданное количество отличается от количества в пачке');
      if(!issuedDay)warnings.push('Не указана дата выдачи');else if(issuedDay>today)warnings.push('Дата выдачи находится в будущем');
      rows.push(Object.assign({},op,{id:id,sewerName:sewer,cutDate:cut,issuedQty:issued,acceptedQty:accepted,defectQty:defects,remainingQty:remaining,issuedDay:issuedDay,daysInWork:age,warnings:warnings}));
    });
    rows.sort(function(a,b){return(a.issuedDay&&b.issuedDay?compare(a.issuedDay,b.issuedDay):a.issuedDay?-1:b.issuedDay?1:0)||compare(a.sewerName,b.sewerName)||compare(a.packId,b.packId)||compare(a.operationName,b.operationName);});
    var groups=new Map();rows.forEach(function(row){if(!groups.has(row.sewerName))groups.set(row.sewerName,[]);groups.get(row.sewerName).push(row);});
    return{rows:rows,totals:summarize(rows),groups:Array.from(groups,function(entry){return Object.assign({name:entry[0]},summarize(entry[1]));}).sort(function(a,b){return compare(a.name,b.name);}),generatedAt:now,options:Object.assign({},options)};
  }
  function csv(report){
    var o=report.options,rows=[['В работе — не принято','Сформировано',report.generatedAt],['Швея',o.sewer||'Все','Модель',o.model||'Все','Крой с',o.cutFrom||'Все даты','по',o.cutTo||'Все даты'],
      ['Пачек',report.totals.packCount,'Остаток по пачкам',report.totals.packRemaining,'Незавершённых операций',report.totals.operationCount,'Остаток по операциям',report.totals.operationRemaining],
      ['Остаток по пачке — максимум остатка по её показанным операциям. Пачка может повторяться у разных швей; суммы по швеям не равны количеству уникальных пачек.'],[],
      ['Швея','Модель','Дата кроя','Пачка ID','Паспорт','Размер','Цвет','Операция','Дата выдачи (Москва)','Дней с выдачи','Выдано','Принято годных','Брак','Осталось по операции','Примечание']];
    report.rows.forEach(function(r){rows.push([r.sewerName,r.model,r.cutDate,r.packId,r.passport||'',r.size||'',r.color||'',r.operationName,r.issuedDay,r.daysInWork,r.issuedQty,r.acceptedQty,r.defectQty,r.remainingQty,r.warnings.join('; ')]);});
    return rows.map(function(row){return row.map(function(value){if(typeof value==='number')return String(value);var s=String(value==null?'':value).replace(/[\r\n\t]/g,' ');if(/^[=+\-@]/.test(s.trimStart()))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}).join(';');}).join('\r\n');
  }
  var state={operations:null,generatedAt:'',report:null,request:0};
  function el(id){return root.document.getElementById('work-'+id);}
  function allowed(){return root.currentUser&&['admin','master','accountant'].indexOf(root.currentUser.role)>=0;}
  function open(){
    if(!allowed())return root.showToast('Недостаточно прав для просмотра работы',true);
    root.showScreen('work-report','🧵 В работе — не принято','Выданные операции и остатки');
    ['cut-from','cut-to','days','search'].forEach(function(id){el(id).value='';});el('kind').value='all';el('sewer').innerHTML='<option value="">Все швеи</option>';el('model').innerHTML='<option value="">Все модели</option>';return load();
  }
  function load(){
    if(!allowed())return;
    var request=++state.request;state.operations=null;state.report=null;el('result').innerHTML='';el('export').hidden=true;root.showLoading('work-report',true);
    return root.API.getWorkInProgress().then(function(data){
      if(request!==state.request||!allowed())return;
      if(!data||!data.success)throw new Error(data&&data.message||'Не удалось загрузить остатки');
      var pending=build(data.operations,{now:data.generatedAt});state.operations=data.operations;state.generatedAt=data.generatedAt;
      ['sewer','model'].forEach(function(key){
        var value=el(key).value;el(key).innerHTML='<option value="">'+(key==='sewer'?'Все швеи':'Все модели')+'</option>';
        Array.from(new Set(pending.rows.map(function(r){return key==='sewer'?r.sewerName:r.model;}))).sort(compare).forEach(function(name){var opt=root.document.createElement('option');opt.value=name;opt.textContent=name;el(key).appendChild(opt);});el(key).value=value;if(!el(key).value)el(key).value='';
      });render();
    }).catch(function(error){if(request===state.request)el('result').innerHTML='<div class="card" role="alert">'+html(error.message)+'</div>';})
      .finally(function(){if(request===state.request)root.showLoading('work-report',false);});
  }
  function render(){
    state.report=null;el('export').hidden=true;if(!state.operations||!allowed())return;
    try{
      var r=build(state.operations,{now:state.generatedAt,sewer:el('sewer').value,model:el('model').value,cutFrom:el('cut-from').value,cutTo:el('cut-to').value,kind:el('kind').value,minDays:el('days').value,search:el('search').value}),t=r.totals;state.report=r;
      var h='<div class="card"><h3>Остатки выданной работы</h3><div class="dash-grid">'+
        '<div><strong>'+t.packCount+'</strong><br>Пачек с остатком</div><div><strong>'+t.packRemaining+'</strong><br>Остаток по пачкам, шт.</div><div><strong>'+t.operationCount+'</strong><br>Незавершённых операций</div><div><strong>'+t.operationRemaining+'</strong><br>Остаток по операциям, шт.</div></div>'+
        '<p>Без приёмки по операции: '+t.withoutAcceptance+' · Частично принято: '+t.partial+'</p><p class="payroll-note">Для каждой пачки берётся максимальный остаток по показанным операциям: несколько операций не удваивают число изделий. Это остаток работы по пачкам, а не сумма операций. Сформировано: '+html(new Date(r.generatedAt).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'}))+' (Москва).</p></div>';
      if(t.warningCount)h+='<div class="card" role="status">⚠️ Требуют проверки данные '+t.warningCount+' операций. Причина указана в расшифровке; записи не изменены.</div>';
      if(!r.rows.length)h+='<div class="card">По выбранным фильтрам непринятой работы нет.</div>';
      else{
        h+='<div class="card payroll-scroll"><table class="payroll-table"><caption>У кого находится работа</caption><thead><tr><th>Швея</th><th>Пачек</th><th>Остаток по пачкам</th><th>Операций</th><th>Остаток по операциям</th></tr></thead><tbody>';
        r.groups.forEach(function(g){h+='<tr><th scope="row">'+html(g.name)+'</th><td>'+g.packCount+'</td><td>'+g.packRemaining+'</td><td>'+g.operationCount+'</td><td>'+g.operationRemaining+'</td></tr>';});
        h+='</tbody></table><p class="payroll-note">Если операции одной пачки выполняют разные швеи, пачка показана у каждой. Итог выше считает каждую пачку один раз.</p></div>';
        h+='<details class="card"><summary>Паспорта и операции ('+r.rows.length+') — раскрыть</summary><div class="work-op-grid">';
        r.rows.forEach(function(x){h+='<article class="work-op-card"><strong>'+html(x.model)+' · '+html(x.size)+' · '+html(x.color)+'</strong><p>'+html(x.packId)+' · Паспорт '+html(x.passport||'не указан')+'</p><p>Швея: <strong>'+html(x.sewerName)+'</strong><br>Операция: '+html(x.operationName)+'</p><p>Выдано: '+x.issuedQty+' · Принято: '+x.acceptedQty+'<br>Брак: '+x.defectQty+' · <strong>Осталось: '+x.remainingQty+'</strong></p><p class="payroll-note">Крой: '+date(x.cutDate)+'<br>Выдача: '+date(x.issuedDay)+' · Дней с выдачи: '+(x.daysInWork===null?'неизвестно':x.daysInWork)+'</p>'+(x.warnings.length?'<p class="payroll-note" style="color:#b45309;">⚠️ '+html(x.warnings.join('. '))+'</p>':'')+'</article>';});
        h+='</div></details>';
      }el('result').innerHTML=h;el('export').hidden=!r.rows.length;
    }catch(error){el('result').innerHTML='<div class="card" role="alert">'+html(error.message)+'</div>';}
  }
  function exportExcel(){
    if(!allowed()||!state.report)return;
    var blob=new Blob(['\uFEFF'+csv(state.report)],{type:'text/csv;charset=utf-8;'}),url=root.URL.createObjectURL(blob),a=root.document.createElement('a');a.href=url;a.download='В_работе_не_принято_'+day(state.generatedAt)+'.csv';root.document.body.appendChild(a);a.click();a.remove();root.setTimeout(function(){root.URL.revokeObjectURL(url);},1000);
  }
  return{build:build,csv:csv,open:open,load:load,render:render,exportExcel:exportExcel};
});
