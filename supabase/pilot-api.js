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

  function loadConfig() {
    if (window.SUPABASE_CONFIG) return Promise.resolve(window.SUPABASE_CONFIG);
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'supabase/config.js';
      script.onload = function () {
        if (!window.SUPABASE_CONFIG) reject(new Error('Файл supabase/config.js не настроен'));
        else resolve(window.SUPABASE_CONFIG);
      };
      script.onerror = function () { reject(new Error('Не найден supabase/config.js')); };
      document.head.appendChild(script);
    });
  }

  function request(path, options) {
    if (!config) return Promise.reject(new Error('Supabase не настроен'));
    var headers = Object.assign({
      apikey: config.anonKey,
      'Content-Type': 'application/json'
    }, options && options.headers);
    if (session && session.access_token) headers.Authorization = 'Bearer ' + session.access_token;
    var started = performance.now();
    return fetch(config.url.replace(/\/$/, '') + path, Object.assign({}, options, { headers: headers }))
      .then(function (response) {
        return response.text().then(function (text) {
          var body = text ? JSON.parse(text) : null;
          if (!response.ok) throw new Error((body && (body.msg || body.message || body.error_description)) || ('HTTP ' + response.status));
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
    return table('pack_operations', 'select=operation_name,sewer_name,issued_qty,accepted_qty,paid_qty,paid_at,issued_at,accepted_at,sewer_price&pack_id=eq.' + encodeURIComponent(packId) + '&order=id.asc')
      .then(function (rows) {
        return rows.map(function (op) {
          return {
            name: op.operation_name,
            sewer: op.sewer_name || '',
            issued: Number(op.issued_qty) || 0,
            accepted: Number(op.accepted_qty) || 0,
            paidQty: Number(op.paid_qty) || 0,
            paidAt: op.paid_at || '',
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
        return table('operation_catalog', 'select=model,operation_name&active=eq.true&order=sequence_no.asc,id.asc')
          .then(function (catalog) {
            var byModel = {};
            catalog.forEach(function (op) {
              if (!byModel[op.model]) byModel[op.model] = [];
              byModel[op.model].push({ operation_name: op.operation_name });
            });
            return {
              success: true,
              count: packs.length,
              packs: packs.map(function (pack) { return packDto(pack, byModel[pack.model]); })
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
      return table('pack_operations', 'select=sewer_name&sewer_name=not.is.null&order=sewer_name.asc').then(function (rows) {
        return Array.from(new Set(rows.map(function (row) { return row.sewer_name; }).filter(Boolean)));
      });
    },
    getDashboardData: function () {
      return rpc('get_dashboard_data', {}).then(unwrapRpc);
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
