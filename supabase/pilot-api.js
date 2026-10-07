(function () {
  'use strict';

  // Этот отдельный сайт всегда работает через Supabase.

  var STATUS_LABELS = {
    new: 'Новая',
    issued: 'Выдано',
    partially_accepted: 'Частично принято',
    accepted: 'Принято',
    annulled: 'Аннулирована'
  };
  var session = null;
  var config = null;
  var originalApi = window.API;
  var refreshPromise = null;
  var configPromise = null;
  var REQUEST_TIMEOUT_MS = 20000;

  function fetchWithTimeout(url, options, timeoutMessage) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);
    return fetch(url, Object.assign({}, options, { signal: controller.signal }))
      .catch(function (error) {
        if (error && error.name === 'AbortError') {
          throw new Error(timeoutMessage || 'Сервер не ответил. Проверьте интернет и повторите попытку.');
        }
        throw error;
      })
      .finally(function () { clearTimeout(timer); });
  }

  function loadConfig() {
    if (window.SUPABASE_CONFIG) return Promise.resolve(window.SUPABASE_CONFIG);
    if (configPromise) return configPromise;
    configPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'supabase/config.js?v=proxy-1';
      var timer = setTimeout(function () {
        reject(new Error('Не удалось загрузить настройки входа. Обновите страницу.'));
      }, 10000);
      script.onload = function () {
        clearTimeout(timer);
        if (!window.SUPABASE_CONFIG) reject(new Error('Файл supabase/config.js не настроен'));
        else resolve(window.SUPABASE_CONFIG);
      };
      script.onerror = function () {
        clearTimeout(timer);
        reject(new Error('Не найден supabase/config.js'));
      };
      document.head.appendChild(script);
    }).catch(function (error) {
      configPromise = null;
      throw error;
    });
    return configPromise;
  }

  function clearExpiredSession() {
    session = null;
    sessionStorage.removeItem('supabasePilotSession');
    window.currentUser = null;
    if (typeof window.showScreen === 'function') window.showScreen('login', 'Швейное производство', 'Войдите снова');
  }

  function refreshSession() {
    if (refreshPromise) return refreshPromise;
    if (!session || !session.refresh_token) return Promise.reject(new Error('Сессия истекла. Войдите снова.'));
    refreshPromise = fetchWithTimeout(config.url.replace(/\/$/, '') + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }, 'Сервер входа не ответил. Проверьте интернет и повторите.').then(function (response) {
      return response.text().then(function (text) {
        var body = text ? JSON.parse(text) : null;
        if (!response.ok || !body || !body.access_token) throw new Error('Сессия истекла. Войдите снова.');
        if (!body.user && session.user) body.user = session.user;
        session = body;
        sessionStorage.setItem('supabasePilotSession', JSON.stringify(session));
        return session;
      });
    }).catch(function (error) {
      clearExpiredSession();
      throw error;
    }).finally(function () { refreshPromise = null; });
    return refreshPromise;
  }

  function request(path, options, allowRefresh) {
    if (!config) return Promise.reject(new Error('Supabase не настроен'));
    var headers = Object.assign({
      apikey: config.anonKey,
      'Content-Type': 'application/json'
    }, options && options.headers);
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    var started = performance.now();
    return fetchWithTimeout(config.url.replace(/\/$/, '') + path, Object.assign({}, options, { headers: headers }),
      path.indexOf('/auth/v1/') === 0
        ? 'Сервер входа не ответил. Проверьте интернет и повторите.'
        : 'Сервер не ответил. Проверьте интернет и повторите.')
      .then(function (response) {
        return response.text().then(function (text) {
          var body = text ? JSON.parse(text) : null;
          if (!response.ok) {
            var message = (body && (body.msg || body.message || body.error_description)) || ('HTTP ' + response.status);
            var authExpired = response.status === 401 || /jwt.*expired|token.*expired|invalid jwt/i.test(message);
            if (allowRefresh !== false && authExpired && session && session.refresh_token && path.indexOf('/auth/v1/token') !== 0) {
              return refreshSession().then(function () { return request(path, options, false); });
            }
            throw new Error(message);
          }
          console.info('[Supabase pilot] ' + path.split('?')[0] + ': ' + Math.round(performance.now() - started) + ' ms');
          return body;
        });
      });
  }

  function table(name, query) {
    return request('/rest/v1/' + name + '?' + query, { method: 'GET' });
  }

  function rpc(name, body) {
    return request('/rest/v1/rpc/' + name, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  function edge(name, body) {
    return request('/functions/v1/' + name, { method: 'POST', body: JSON.stringify(body || {}) });
  }

  function unwrapRpc(result) {
    if (Array.isArray(result) && result.length === 1) return result[0];
    return result;
  }

  function statusLabel(value) { return STATUS_LABELS[value] || value || 'Новая'; }
  function dateText(value) { return value ? String(value).slice(0, 10) : ''; }
  function sewerReportFromRows(sewerName, dateFrom, dateTo, dateKind, operations, packs) {
    var packById = {};
    packs.forEach(function (pack) { packById[pack.id] = pack; });
    var details = operations.map(function (op) {
      var pack = packById[op.pack_id] || {};
      var accepted = Number(op.accepted_qty) || 0, paid = Number(op.paid_qty) || 0;
      return { packId: op.pack_id, passport: pack.passport_no || '', model: pack.model || 'Без модели', operationName: op.operation_name,
        issuedQty: Number(op.issued_qty) || 0, acceptedQty: accepted, defectQty: Number(op.defect_qty) || 0,
        remainingQty: Math.max(0,(Number(op.issued_qty)||0)-accepted-(Number(op.defect_qty)||0)), paidQty: paid,
        issuedAt: op.issued_at, acceptedAt: op.accepted_at, paidAt: op.paid_at,
        paymentStatus: accepted === 0 ? 'Нет приёмки' : paid >= accepted ? 'Оплачено' : paid > 0 ? 'Частично оплачено' : 'Не оплачено' };
    });
    var byPack = {}, byModel = {};
    details.forEach(function (row) {
      var key = row.model + '\n' + row.packId;
      if (!byPack[key]) byPack[key] = { model: row.model, issuedQty: row.issuedQty, acceptedQty: row.acceptedQty,
        defectQty: 0, processedQty: row.acceptedQty + row.defectQty, paidQty: row.paidQty, lastPaidAt: row.paidAt };
      else { byPack[key].issuedQty=Math.max(byPack[key].issuedQty,row.issuedQty);byPack[key].acceptedQty=Math.min(byPack[key].acceptedQty,row.acceptedQty);
        byPack[key].processedQty=Math.min(byPack[key].processedQty,row.acceptedQty+row.defectQty);byPack[key].paidQty=Math.min(byPack[key].paidQty,row.paidQty);
        if(row.paidAt&&(!byPack[key].lastPaidAt||row.paidAt>byPack[key].lastPaidAt))byPack[key].lastPaidAt=row.paidAt; }
      byPack[key].defectQty += row.defectQty;
    });
    Object.keys(byPack).forEach(function (key) { var row=byPack[key], model=byModel[row.model]||(byModel[row.model]={model:row.model,packCount:0,issuedQty:0,acceptedQty:0,defectQty:0,remainingQty:0,paidQty:0,lastPaidAt:null});
      model.packCount++;model.issuedQty+=row.issuedQty;model.acceptedQty+=row.acceptedQty;model.defectQty+=row.defectQty;
      model.remainingQty+=Math.max(0,row.issuedQty-row.processedQty);model.paidQty+=row.paidQty;
      if(row.lastPaidAt&&(!model.lastPaidAt||row.lastPaidAt>model.lastPaidAt))model.lastPaidAt=row.lastPaidAt; });
    var summary=Object.keys(byModel).sort().map(function(key){var row=byModel[key];row.paymentStatus=row.acceptedQty===0?'Нет приёмки':row.paidQty>=row.acceptedQty?'Оплачено':row.paidQty>0?'Частично оплачено':'Не оплачено';return row;});
    return { success:true,sewerName:sewerName,dateFrom:dateFrom,dateTo:dateTo,dateKind:dateKind,summary:summary,details:details };
  }
  function packDto(pack, operations) {
    return {
      id: pack.id,
      dateCut: dateText(pack.cut_date),
      model: pack.model,
      size: pack.size,
      qty: Number(pack.quantity) || 0,
      passport: pack.passport_no || '',
      color: pack.color || '',
      status: statusLabel(pack.status),
      operations: (operations || []).map(function (op) { return op.operation_name; })
    };
  }

  function operationsForPack(packId) {
    return table('pack_operations', 'select=operation_name,sewer_name,issued_qty,accepted_qty,defect_qty,paid_qty,paid_at,client_paid_qty,client_paid_at,issued_at,accepted_at,sewer_price&pack_id=eq.' + encodeURIComponent(packId) + '&order=id.asc')
      .then(function (rows) {
        return rows.map(function (op) {
          return {
            name: op.operation_name,
            sewer: op.sewer_name || '',
            issued: Number(op.issued_qty) || 0,
            accepted: Number(op.accepted_qty) || 0,
            defect: Number(op.defect_qty) || 0,
            paidQty: Number(op.paid_qty) || 0,
            paidAt: op.paid_at || '',
            clientPaidQty: Number(op.client_paid_qty) || 0,
            clientPaidAt: op.client_paid_at || '',
            issuedDate: op.issued_at || '',
            acceptedDate: op.accepted_at || '',
            price: Number(op.sewer_price) || 0,
            priceSewer: Number(op.sewer_price) || 0
          };
        });
      });
  }

  function getPack(id) {
    return table('packs', 'select=*&id=eq.' + encodeURIComponent(id) + '&limit=1')
      .then(function (rows) { return rows[0] || null; });
  }

  function readOnlyError() {
    return Promise.resolve({ success: false, message: 'Пилот Supabase работает только на чтение. Запись остаётся в рабочей системе.' });
  }

  function profileForSession(authSession) {
    session = authSession;
    sessionStorage.setItem('supabasePilotSession', JSON.stringify(authSession));
    return table('profiles', 'select=display_name,role,active&id=eq.' + encodeURIComponent(authSession.user ? authSession.user.id : authSession.user_id) + '&limit=1')
      .then(function (profiles) {
        var profile = profiles[0];
        if (!profile || !profile.active) throw new Error('Профиль пользователя не активирован');
        return { success: true, name: profile.display_name, role: profile.role, pin: '' };
      });
  }

  function sessionFromHash() {
    if (!window.location.hash) return null;
    var hash = new URLSearchParams(window.location.hash.slice(1));
    var accessToken = hash.get('access_token');
    if (!accessToken) return null;
    return {
      access_token: accessToken,
      refresh_token: hash.get('refresh_token') || '',
      expires_in: Number(hash.get('expires_in')) || 3600,
      token_type: hash.get('token_type') || 'bearer',
      user_id: hash.get('user_id') || ''
    };
  }

  function finishMagicLinkLogin() {
    var hashSession = sessionFromHash();
    if (!hashSession) return;
    loadConfig().then(function (loaded) {
      config = loaded;
      session = hashSession;
      return request('/auth/v1/user', { method: 'GET' });
    }).then(function (user) {
      hashSession.user = user;
      return profileForSession(hashSession);
    }).then(function (result) {
      history.replaceState(null, '', location.pathname + location.search);
      showAuthenticatedHome(result);
      if (typeof window.showToast === 'function') window.showToast('Вход выполнен: ' + result.name);
    }).catch(function (error) {
      if (typeof window.showToast === 'function') window.showToast('Ошибка входа: ' + error.message, true);
    });
  }

  function showAuthenticatedHome(result) {
    window.currentUser = { name: result.name, pin: '', role: result.role };
    if (typeof window.buildHomeMenu === 'function') window.buildHomeMenu();
    if (typeof window.showScreen === 'function') window.showScreen('home', 'Швейное производство', 'Supabase · рабочая версия');
  }

  function sendMagicLink(email) {
    if (!email) return Promise.resolve({ success: false, message: 'Введите email' });
    var redirectUrl = window.location.origin + window.location.pathname;
    return loadConfig().then(function (loaded) {
      config = loaded;
      return request('/auth/v1/otp?redirect_to=' + encodeURIComponent(redirectUrl), {
        method: 'POST',
        body: JSON.stringify({ email: email, create_user: false })
      });
    }).then(function () {
      return { success: true, message: 'Ссылка для входа отправлена на ' + email };
    }).catch(function (error) {
      return { success: false, message: error.message };
    });
  }

  function restoreSavedLogin() {
    if (sessionFromHash()) return;
    var saved = sessionStorage.getItem('supabasePilotSession');
    if (!saved) return;
    try { session = JSON.parse(saved); }
    catch (error) { sessionStorage.removeItem('supabasePilotSession'); return; }
    loadConfig().then(function (loaded) {
      config = loaded;
      return request('/auth/v1/user', { method: 'GET' }).catch(function () {
        if (!session.refresh_token) throw new Error('Сессия истекла');
        return request('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          body: JSON.stringify({ refresh_token: session.refresh_token })
        }).then(function (refreshed) {
          session = refreshed;
          sessionStorage.setItem('supabasePilotSession', JSON.stringify(refreshed));
          return refreshed.user;
        });
      });
    }).then(function (user) {
      session.user = user;
      return profileForSession(session);
    }).then(showAuthenticatedHome).catch(function () {
      session = null;
      sessionStorage.removeItem('supabasePilotSession');
    });
  }

  var pilotApi = Object.assign({}, originalApi, {
    login: function (password) {
      var emailInput = document.getElementById('login-email');
      var email = emailInput ? emailInput.value.trim().toLowerCase() : '';
      if (email && email.indexOf('@') === -1) email += '@users.sewing.local';
      if (!email || !password) return Promise.resolve({ success: false, message: 'Введите логин и пароль' });
      return loadConfig().then(function (loaded) {
        config = loaded;
        return request('/auth/v1/token?grant_type=password', {
          method: 'POST',
          body: JSON.stringify({ email: email, password: password })
        });
      }).then(function (auth) {
        return profileForSession(auth);
      }).catch(function (error) {
        session = null;
        sessionStorage.removeItem('supabasePilotSession');
        return { success: false, message: error.message };
      });
    },

    checkConnection: function () {
      return loadConfig().then(function (loaded) {
        config = loaded;
        var saved = sessionStorage.getItem('supabasePilotSession');
        if (saved && !session) session = JSON.parse(saved);
        return request('/auth/v1/settings', { method: 'GET' });
      }).then(function () { return { success: true }; });
    },

    getAllPacks: function () {
      return table('packs', 'select=*&order=cut_date.desc,id.desc').then(function (packs) {
        return Promise.all([
          table('operation_catalog', 'select=model,operation_name&active=eq.true&order=sequence_no.asc,id.asc'),
          table('pack_operations', 'select=pack_id,issued_qty,accepted_qty,defect_qty&issued_qty=gt.0')
        ]).then(function (result) {
            var catalog=result[0],operationRows=result[1];
            var byModel = {};
            catalog.forEach(function (op) {
              if (!byModel[op.model]) byModel[op.model] = [];
              byModel[op.model].push({ operation_name: op.operation_name });
            });
            var progressByPack={};
            operationRows.forEach(function(op){
              var accepted=Number(op.accepted_qty)||0,processed=accepted+(Number(op.defect_qty)||0);
              if(!progressByPack[op.pack_id])progressByPack[op.pack_id]={acceptedQty:accepted,processedQty:processed};
              else{progressByPack[op.pack_id].acceptedQty=Math.min(progressByPack[op.pack_id].acceptedQty,accepted);progressByPack[op.pack_id].processedQty=Math.min(progressByPack[op.pack_id].processedQty,processed);}
            });
            return {
              success: true,
              count: packs.length,
              packs: packs.map(function (pack) {var dto=packDto(pack,byModel[pack.model]),progress=progressByPack[pack.id]||{acceptedQty:0,processedQty:0};dto.acceptedQty=progress.acceptedQty;dto.processedQty=progress.processedQty;dto.remainingQty=Math.max(0,dto.qty-progress.processedQty);return dto;})
            };
          });
      });
    },

    getPackStatus: function (qr) {
      var id = String(qr || '').split('|')[0].trim();
      return Promise.all([getPack(id), operationsForPack(id)]).then(function (result) {
        if (!result[0]) return { success: false, message: 'Пачка не найдена' };
        return Object.assign({ success: true }, packDto(result[0]), { operations: result[1] });
      });
    },

    getPassportData: function (packId) {
      return getPack(packId).then(function (pack) {
        if (!pack) return { success: false, message: 'Пачка не найдена' };
        return table('operation_catalog', 'select=operation_name&active=eq.true&model=eq.' + encodeURIComponent(pack.model) + '&order=sequence_no.asc,id.asc')
          .then(function (operations) {
            return Object.assign({ success: true }, packDto(pack, operations));
          });
        });
    },

    getModelList: function () {
      return table('operation_catalog', 'select=model&active=eq.true&order=model.asc').then(function (rows) {
        return Array.from(new Set(rows.map(function (row) { return row.model; })));
      });
    },

    getModelOperations: function (model) {
      return table('operation_catalog', 'select=operation_name,sewer_price&active=eq.true&model=eq.' + encodeURIComponent(model) + '&order=sequence_no.asc,id.asc')
        .then(function (rows) {
          return rows.map(function (row) { return { name: row.operation_name, price: Number(row.sewer_price), priceSewer: Number(row.sewer_price) }; });
        });
    },

    getSewerList: function () {
      return Promise.all([
        table('profiles', 'select=display_name,active&role=eq.sewer&order=display_name.asc'),
        table('pack_operations', 'select=sewer_name&sewer_name=not.is.null&order=sewer_name.asc')
      ]).then(function (result) {
        var profiles=result[0],history=result[1],inactive=new Set(),names=[];
        profiles.forEach(function(row){if(row.active)names.push(row.display_name);else inactive.add(row.display_name);});
        history.forEach(function(row){if(row.sewer_name&&!inactive.has(row.sewer_name))names.push(row.sewer_name);});
        return Array.from(new Set(names.filter(Boolean))).sort();
      });
    },
    getDashboardData: function () {
      return rpc('get_dashboard_data', {}).then(unwrapRpc);
    },
    getCostCalculatorData: function () {
      return rpc('get_cost_calculator_data', {}).then(unwrapRpc);
    },
    saveCostSettings: function (settings) {
      return rpc('save_cost_settings', { p_settings: settings }).then(unwrapRpc);
    },
    saveProductionOrder: function (order) {
      return rpc('save_production_order', { p_order: order }).then(unwrapRpc);
    },
    getProductionOrderReport: function (orderId) {
      return rpc('get_production_order_report', { p_order_id: Number(orderId) }).then(unwrapRpc);
    },
    assignPacksToOrder: function (orderId, packIds) {
      return rpc('assign_packs_to_order', { p_order_id: Number(orderId), p_pack_ids: packIds }).then(unwrapRpc);
    },
    unassignPackFromOrder: function (orderId, packId) {
      return rpc('unassign_pack_from_order', { p_order_id: Number(orderId), p_pack_id: packId }).then(unwrapRpc);
    },
    getCatalogAdmin: function () {
      return rpc('get_catalog_admin', {}).then(unwrapRpc);
    },
    saveCatalogOperation: function (item) {
      return rpc('save_catalog_operation', { p_id: item.id || null, p_model: item.model, p_operation_name: item.operationName,
        p_sequence_no: Number(item.sequenceNo), p_sewer_price: Number(item.sewerPrice), p_client_price: Number(item.clientPrice), p_active: item.active !== false }).then(unwrapRpc);
    },
    copyCatalogModel: function (sourceModel, newModel) {
      return rpc('copy_catalog_model', { p_source_model: sourceModel, p_new_model: newModel }).then(unwrapRpc);
    },
    deleteCatalogOperation: function (id) {
      return rpc('delete_catalog_operation', { p_id: Number(id) }).then(unwrapRpc);
    },
    getPaymentOperations: function () {
      return rpc('get_payment_operations', {}).then(unwrapRpc);
    },
    getSewerPeriodReport: function (sewerName, dateFrom, dateTo, dateKind) {
      return rpc('get_sewer_period_report', {
        p_sewer_name: sewerName,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_date_kind: dateKind || 'accepted'
      }).then(unwrapRpc).catch(function (rpcError) {
        var field = dateKind === 'issued' ? 'issued_at' : dateKind === 'paid' ? 'paid_at' : 'accepted_at';
        var query='select=pack_id,operation_name,issued_qty,accepted_qty,defect_qty,paid_qty,issued_at,accepted_at,paid_at,sewer_name'+
          '&sewer_name=eq.'+encodeURIComponent(sewerName)+'&'+field+'=gte.'+dateFrom+'T00:00:00Z&'+field+'=lte.'+dateTo+'T23:59:59.999Z&order='+field+'.asc';
        return Promise.all([table('pack_operations',query),table('packs','select=id,model,passport_no,status&status=neq.annulled')])
          .then(function(result){return sewerReportFromRows(sewerName,dateFrom,dateTo,dateKind||'accepted',result[0],result[1]);})
          .catch(function(){throw rpcError;});
      });
    },
    setOperationsPayment: function (items, kind, paid) {
      return rpc('set_operations_payment', { p_items: items, p_kind: kind, p_paid: paid !== false }).then(unwrapRpc);
    },
    getSewerPacks: function () {
      return rpc('get_my_packs', {}).then(unwrapRpc);
    },
    getUsers: function () {
      return rpc('get_managed_users', {}).then(unwrapRpc);
    },
    scanAssign: function (qr, operationsData) {
      return rpc('issue_pack', { p_pack_id: String(qr).split('|')[0].trim(), p_operations: operationsData });
    },
    scanFinish: function (qr, acceptedByOperation) {
      if (!Array.isArray(acceptedByOperation)) return readOnlyError();
      return rpc('accept_pack', { p_pack_id: String(qr).split('|')[0].trim(), p_operations: acceptedByOperation });
    },
    cancelIssue: function (qr) {
      return rpc('cancel_pack_issue', { p_pack_id: String(qr).split('|')[0].trim() });
    },
    addPack: function (model, size, qty, passport, color) {
      return rpc('create_pack', { p_model: model, p_size: size, p_quantity: Number(qty), p_passport_no: passport || '', p_color: color || '' });
    },
    addPacksBulk: function (rows) {
      return rpc('create_packs_bulk', { p_rows: rows }).then(unwrapRpc);
    },
    editPackPassport: function (id, fields) {
      return rpc('edit_pack', { p_pack_id: id, p_cut_date: fields.dateCut, p_model: fields.model, p_size: fields.size,
        p_quantity: Number(fields.qty), p_passport_no: fields.passport || '', p_color: fields.color || '' });
    },
    annulPackPassport: function (id, reason) {
      return rpc('annul_pack', { p_pack_id: id, p_reason: reason });
    },
    markOperationPaid: function (packId, operationName) {
      return rpc('mark_operation_paid', { p_pack_id: packId, p_operation_name: operationName }).then(unwrapRpc);
    },
    unmarkOperationPaid: function (packId, operationName) {
      return rpc('unmark_operation_paid', { p_pack_id: packId, p_operation_name: operationName }).then(unwrapRpc);
    },
    addUser: function (name, pin, role, unusedAdminPin, login) {
      return edge('manage-user', { action: 'create', name: name, login: login, pin: pin, role: role });
    },
    resetUserPin: function (profileId, pin) {
      return rpc('reset_user_pin', { p_profile_id: profileId, p_pin: pin }).then(unwrapRpc);
    },
    toggleUser: function (profileId) {
      return rpc('toggle_profile_active', { p_profile_id: profileId }).then(unwrapRpc);
    }
  });

  window.API = pilotApi;
  window.SUPABASE_PILOT = true;

  document.addEventListener('DOMContentLoaded', function () {
    var pin = document.getElementById('login-pin');
    var label = document.querySelector('label[for="login-pin"]');
    if (!pin || !label) return;
    var email = document.createElement('input');
    email.id = 'login-email';
    email.type = 'email';
    email.autocomplete = 'username';
    email.placeholder = 'Email или логин';
    email.style.cssText = pin.style.cssText;
    email.style.marginBottom = '10px';
    pin.parentNode.insertBefore(email, pin);
    pin.type = 'password';
    pin.inputMode = 'text';
    pin.removeAttribute('maxlength');
    pin.placeholder = 'Пароль';
    pin.autocomplete = 'current-password';
    label.textContent = 'Вход в рабочую систему';
    var loginButton = pin.parentNode.querySelector('button');
    var magicButton = document.createElement('button');
    magicButton.type = 'button';
    magicButton.className = 'action-btn btn-secondary';
    magicButton.textContent = '✉️ Получить ссылку для входа';
    magicButton.addEventListener('click', function () {
      var address = email.value.trim();
      magicButton.disabled = true;
      sendMagicLink(address).then(function (result) {
        magicButton.disabled = false;
        if (typeof window.showToast === 'function') window.showToast(result.message, !result.success);
      });
    });
    if (loginButton) loginButton.insertAdjacentElement('afterend', magicButton);
    var badge = document.createElement('div');
    badge.textContent = '⚡ РАБОЧАЯ ВЕРСИЯ';
    badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9999;background:#0f766e;color:#fff;padding:6px 10px;border-radius:12px;font:700 11px system-ui;';
    document.body.appendChild(badge);
    finishMagicLinkLogin();
    restoreSavedLogin();
  });
})();
