(function (root, factory) {
  'use strict';
  var api = factory(root, typeof module === 'object' && module.exports ? require('./payroll-statement.js') : root.PayrollStatement);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.PayrollRecovery = api;
    root.openPayrollRecovery = api.open;
    root.loadPayrollRecovery = api.load;
    root.clearPayrollRecovery = api.clear;
    root.filterPayrollRecovery = api.filter;
    root.selectAllPayrollRecovery = api.selectAll;
    root.recordPayrollRecovery = api.record;
    root.exportPayrollRecovery = api.exportExcel;
  }
})(typeof window === 'object' ? window : globalThis, function (root, payroll) {
  'use strict';
  function quantity(value) {
    if (value === null || value === '' || !Number.isSafeInteger(Number(value)) || Number(value) < 0) throw new Error('Некорректное количество в сверке');
    return Number(value);
  }
  function safe(value) { if (!Number.isSafeInteger(value)) throw new Error('Сумма превышает допустимое значение'); return value; }
  function html(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function money(value) { return (value / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }); }
  function date(value) { return value.slice(8,10) + '.' + value.slice(5,7) + '.' + value.slice(0,4); }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var parsed=new Date(value+'T12:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
  }
  function today() { return new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date()); }
  function build(data, options) {
    options = options || {};
    if (!data || !data.success || !validDate(data.paymentDate) || !Array.isArray(data.operations)) throw new Error('Не удалось загрузить сверку');
    var seen = new Set(), rows = [], groups = new Map();
    data.operations.forEach(function (op) {
      var id = String(op.operationId);
      if (!/^[0-9]+$/.test(id) || seen.has(id)) throw new Error('Неоднозначная операция в сверке');
      seen.add(id);
      if (!op.packId || !op.operationName || !op.sewerName || !op.model || !/^[a-f0-9]{32}$/.test(op.fingerprint)) throw new Error('Неполные данные операции');
      var accepted = quantity(op.acceptedNow), paid = quantity(op.paidQty), price = payroll.cents(op.price);
      if (paid > accepted) throw new Error('Оплаченное количество превышает принятое');
      var review = op.acceptedBefore === null;
      if (review !== op.needsReview) throw new Error('Не подтверждена история приёмки');
      var before = review ? null : quantity(op.acceptedBefore), add = review ? null : Math.max(0, before - paid);
      if (!review && (before > accepted || add !== quantity(op.recoveryQty) || quantity(op.remainingAfter) !== accepted - Math.max(before,paid))) throw new Error('Расчёт изменился. Обновите сверку');
      if (options.sewer && op.sewerName !== options.sewer || options.model && op.model !== options.model) return;
      if (!review && before === 0) return;
      var group = groups.get(op.sewerName);
      if (!group) { group = { name:op.sewerName,beforeQty:0,coveredQty:0,addQty:0,amountCents:0,reviewCount:0,operationCount:0 }; groups.set(op.sewerName,group); }
      if (review) group.reviewCount++;
      else {
        group.beforeQty = safe(group.beforeQty + before); group.coveredQty = safe(group.coveredQty + Math.min(paid,before));
        group.addQty = safe(group.addQty + add); group.amountCents = safe(group.amountCents + safe(add * price));
        if (add > 0) group.operationCount++;
      }
      if (!review && !add && options.mode !== 'all') return;
      rows.push(Object.assign({},op,{ id:id,priceCents:price,amountCents:review?0:safe(add*price),addQty:add }));
    });
    var summary = Array.from(groups.values()).filter(function (group) { return options.mode==='all'||group.operationCount>0||group.reviewCount>0; }), total = { amountCents:0,operationCount:0,reviewCount:0 };
    summary.forEach(function (group) { Object.keys(total).forEach(function (key) { total[key] = safe(total[key]+group[key]); }); });
    return { paymentDate:data.paymentDate,generatedAt:data.generatedAt,rows:rows,groups:summary,totals:total };
  }
  function selection(report, ids) {
    var items = [], amount = 0, groups = new Map();
    report.rows.forEach(function (row) {
      if (!ids.has(row.id)) return;
      if (row.needsReview || !row.addQty) throw new Error('Выбрана неподтверждённая операция');
      items.push({ operationId:row.id,fingerprint:row.fingerprint });
      amount = safe(amount+row.amountCents); groups.set(row.sewerName,safe((groups.get(row.sewerName)||0)+row.amountCents));
    });
    if (items.length !== ids.size) throw new Error('Выбранные операции изменились. Обновите сверку');
    return { items:items,amountCents:amount,groups:Array.from(groups,function (entry) { return { name:entry[0],amountCents:entry[1] }; }) };
  }
  function csv(report) {
    var rows = [['Сверка прошлой выплаты',report.paymentDate],['Часовой пояс','Europe/Moscow'],
      ['К восстановлению в учёте, ₽',report.totals.amountCents/100],
      ['Это сверка текущего учёта. Сохранение файла не отмечает оплату. Уже учтённые оплаты засчитываются в раннюю работу.'],[],
      ['Швея','Модель','Дата кроя','Пачка ID','Паспорт','Операция','Принято к дате выплаты','Сейчас принято','Учтено оплаченных сейчас','Добавить в оплату','Расценка, ₽','Сумма, ₽','Проверка']];
    report.rows.forEach(function (r) { rows.push([r.sewerName,r.model,r.cutDate||'',r.packId,r.passport||'',r.operationName,r.acceptedBefore,r.acceptedNow,r.paidQty,r.addQty,r.priceCents/100,r.amountCents/100,r.needsReview?'Требуется проверка истории':'История подтверждена']); });
    return rows.map(function (row) { return row.map(function (value) {
      if (typeof value === 'number') return String(value).replace('.',',');
      var text = String(value==null?'':value).replace(/[\r\n\t]/g,' '); if (/^[=+\-@]/.test(text.trimStart())) text="'"+text;
      return '"'+text.replace(/"/g,'""')+'"';
    }).join(';'); }).join('\r\n');
  }

  var state = { data:null,report:null,selected:new Set(),request:0,busy:false,pending:null };
  function el(id) { return root.document.getElementById('recovery-'+id); }
  function allowed() { return root.currentUser && ['admin','accountant'].indexOf(root.currentUser.role)>=0; }
  function clear() {
    if (state.busy) return;
    state.request++;state.data=null;state.report=null;state.selected.clear();state.pending=null;
    el('result').innerHTML='';el('actions').hidden=true;el('notice').innerHTML='';root.showLoading('payroll-recovery',false);
  }
  function open() {
    if (!allowed() || typeof root.API.getPayrollRecovery !== 'function') { root.showToast('Недостаточно прав для сверки выплаты',true); return; }
    if (state.busy) return;
    root.showScreen('payroll-recovery','🗓️ Прошлая выплата','Восстановление пропущенной отметки');clear();
    var requested = new URLSearchParams(root.location.search).get('payrollDate');
    el('date').value = requested && validDate(requested) && requested<=today() ? requested : today();
    el('sewer').innerHTML='<option value="">Все швеи</option>';el('model').innerHTML='<option value="">Все модели</option>';el('mode').value='due';
  }
  function load() {
    if (!allowed() || state.busy) return;
    var paymentDate=el('date').value;
    clear();
    if (!validDate(paymentDate) || paymentDate>today()) { root.showToast('Укажите дату состоявшейся выплаты',true); return; }
    var request=++state.request;root.showLoading('payroll-recovery',true);
    return root.API.getPayrollRecovery(paymentDate).then(function (data) {
      if (request!==state.request || paymentDate!==el('date').value) return;
      build(data);state.data=data;
      ['sewer','model'].forEach(function (key) {
        var value=el(key).value;el(key).innerHTML='<option value="">'+(key==='sewer'?'Все швеи':'Все модели')+'</option>';
        Array.from(new Set(data.operations.filter(function (r) { return r.needsReview || r.acceptedBefore>0; }).map(function (r) { return key==='sewer'?r.sewerName:r.model; }))).sort(function (a,b) { return a.localeCompare(b,'ru'); }).forEach(function (name) {
          var option=root.document.createElement('option');option.value=name;option.textContent=name;el(key).appendChild(option);
        });el(key).value=value;if (!el(key).value) el(key).value='';
      });render();
    }).catch(function (error) { if (request===state.request) el('result').innerHTML='<div class="card" role="alert">'+html(error.message)+'</div>'; })
      .finally(function () { if (request===state.request) root.showLoading('payroll-recovery',false); });
  }
  function filter() { if (!state.busy) { state.selected.clear();render(); } }
  function render() {
    if (!state.data) return;
    try {
      var report=build(state.data,{ sewer:el('sewer').value,model:el('model').value,mode:el('mode').value });state.report=report;
      var h='<div class="card"><h3>Выплата '+date(report.paymentDate)+'</h3><p><strong>Не отмечено в учёте: '+money(report.totals.amountCents)+' ₽</strong></p><p>Операций к восстановлению: '+report.totals.operationCount+'. Требуют отдельной проверки: '+report.totals.reviewCount+'.</p><p class="payroll-note">Сумма по выбранным фильтрам. Количество показано по операциям, а не по готовым изделиям. Сверьте суммы с фактически выданной зарплатой.</p></div>';
      report.groups.forEach(function (g) {
        h+='<div class="card"><strong>'+html(g.name)+' — '+money(g.amountCents)+' ₽</strong><p>Принято к дате: '+g.beforeQty+' · Уже учтено: '+g.coveredQty+' · Добавить: '+g.addQty+'</p><p>Операций к отметке: '+g.operationCount+(g.reviewCount?' · Проверить: '+g.reviewCount:'')+'</p></div>';
      });
      if (report.rows.length) {
        h+='<details class="card"><summary>Паспорта и операции: '+report.rows.length+' — раскрыть для сверки</summary><div class="payroll-scroll"><table class="payroll-table"><caption>Состав прошлой выплаты</caption><thead><tr><th>Выбрать</th><th>Швея / модель / крой / паспорт</th><th>Операция</th><th>Принято к дате</th><th>Учтено</th><th>Добавить</th><th>Расценка, ₽</th><th>Сумма, ₽</th></tr></thead><tbody>';
        report.rows.forEach(function (r) {
          h+='<tr><td>'+(r.addQty>0&&!r.needsReview?'<input type="checkbox" data-recovery-id="'+r.id+'" aria-label="'+html(r.sewerName+', '+r.packId+', '+r.operationName)+'" style="width:24px;height:24px;"'+(state.selected.has(r.id)?' checked':'')+'>':'—')+'</td><td>'+html(r.sewerName)+'<br><strong>'+html(r.model)+'</strong><br>'+(r.cutDate?date(r.cutDate):'Крой не указан')+'<br>'+html(r.packId)+' · '+html(r.passport)+'</td><td>'+html(r.operationName)+'</td><td>'+(r.needsReview?'Проверить журнал':r.acceptedBefore)+'</td><td>'+(r.needsReview?'—':Math.min(r.paidQty,r.acceptedBefore))+'</td><td>'+(r.needsReview?'—':r.addQty)+'</td><td>'+money(r.priceCents)+'</td><td>'+money(r.amountCents)+'</td></tr>';
        });h+='</tbody></table></div></details>';
      } else h+='<div class="card">По выбранным фильтрам пропущенных отметок нет.</div>';
      el('result').innerHTML=h;el('actions').hidden=!report.rows.length;
      el('result').querySelectorAll('[data-recovery-id]').forEach(function (input) { input.addEventListener('change',function () {
        if (state.busy) return; var id=input.getAttribute('data-recovery-id');if (input.checked) state.selected.add(id);else state.selected.delete(id);updateSelection();
      }); });updateSelection();
    } catch (error) { state.report=null;el('actions').hidden=true;el('result').innerHTML='<div class="card" role="alert">'+html(error.message)+'</div>'; }
  }
  function updateSelection() {
    if (!state.report) return;
    var selected=selection(state.report,state.selected),available=state.report.rows.filter(function (r) { return r.addQty>0&&!r.needsReview; }).length;
    el('selection').textContent='Выбрано операций: '+selected.items.length+' · К отметке: '+money(selected.amountCents)+' ₽';
    el('record').disabled=state.busy||!selected.items.length;el('select-all').checked=available>0&&selected.items.length===available;
  }
  function selectAll(checked) {
    if (state.busy || !state.report) return;
    state.selected.clear();if (checked) state.report.rows.forEach(function (r) { if (r.addQty>0&&!r.needsReview) state.selected.add(r.id); });render();
  }
  function setBusy(busy) {
    state.busy=busy;root.document.querySelectorAll('#screen-payroll-recovery input,#screen-payroll-recovery select,#screen-payroll-recovery button').forEach(function (input) { input.disabled=busy; });updateSelection();
  }
  function record() {
    if (!allowed() || state.busy || !state.report || !state.data || el('date').value!==state.report.paymentDate) return;
    var selected=selection(state.report,state.selected);if (!selected.items.length) return;
    var prompt='Подтверждаете, что зарплата '+date(state.report.paymentDate)+' уже выдана?\n'+selected.groups.map(function (g) { return g.name+': '+money(g.amountCents)+' ₽'; }).join('\n')+'\nВсего '+money(selected.amountCents)+' ₽, '+selected.items.length+' операций.\nВнести выбранные суммы в учёт датой выплаты?';
    if (!root.confirm(prompt)) return;
    var paymentDate=state.report.paymentDate,key=JSON.stringify([paymentDate,selected.items]);
    if (!state.pending || state.pending.key!==key) state.pending={ key:key,id:root.crypto.randomUUID() };
    setBusy(true);root.showLoading('payroll-recovery',true);
    return root.API.recordPayrollRecovery(paymentDate,selected.items,state.pending.id).then(function (result) {
      if (!result || !result.success) throw new Error(result&&result.message||'Не удалось внести выплату');
      state.pending=null;setBusy(false);
      return load().then(function () { el('notice').innerHTML='<div class="card" role="status">Выплата '+date(paymentDate)+' внесена в учёт. Операций: '+result.count+'. Сумма: '+html(result.amount)+' ₽. Номер записи: '+html(result.batchId)+'.</div>'; });
    }).catch(function (error) { el('notice').innerHTML='<div class="card" role="alert">'+html(error.message)+' При потере связи повторите подтверждение с тем же выбором: повторная запись не увеличит оплату.</div>'; })
      .finally(function () { setBusy(false);root.showLoading('payroll-recovery',false); });
  }
  function exportExcel() {
    if (!allowed() || !state.report) return;
    var blob=new Blob(['\uFEFF'+csv(state.report)],{type:'text/csv;charset=utf-8;'}),url=root.URL.createObjectURL(blob),a=root.document.createElement('a');
    a.href=url;a.download='Сверка_выплаты_'+state.report.paymentDate+'.csv';root.document.body.appendChild(a);a.click();a.remove();root.setTimeout(function () { root.URL.revokeObjectURL(url); },1000);
  }
  return { build:build,selection:selection,csv:csv,open:open,load:load,clear:clear,filter:filter,selectAll:selectAll,record:record,exportExcel:exportExcel };
});
