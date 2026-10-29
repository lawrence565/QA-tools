/*
 * S8N-13257 E2E probe
 *
 * 觀察宿主頁上 ecLogin 換帳號時，/ec/customer/mapping 帶的是不是「這次輪換後的新 livechat 身份」。
 * 不改 MA / LiveChat 的任何程式碼，只包裝它們掛在 window 上的函式、攔截 XHR、輪詢 cookie。
 *
 * 用法：
 *   1. 在 MA 與 LiveChat 的 launch.js 載入「之前」執行（host.html 已內建）。
 *      也可以貼到任意宿主頁的 DevTools Console，但頁面載入當下就呼叫的 ecLogin 會漏記。
 *   2. 操作登入、換帳號、登出。換頁後紀錄仍在（存在 sessionStorage）。
 *   3. S8N13257.report()      在 Console 印出判定表，並回傳結果物件。
 *      S8N13257.exportJSON()  下載證據檔，給 verify_binding.py 使用。
 *      S8N13257.clear()       清除紀錄與故障注入。
 *
 * 故障注入（只影響本分頁，換頁後仍有效）：
 *   S8N13257.inject({ delayTokenMs: 3000 })  widget 寫回新 token 延後 3 秒（模擬慢網路）
 *   S8N13257.inject({ dropToken: true })     丟掉 widget 寫回的新 token（模擬逾時）
 *   S8N13257.inject({ failRotation: true })  createNewLivechatCustomer 拋錯（模擬 iframe 未就緒）
 *   S8N13257.inject({ failCheckBind: true }) 下一支 checkBindStatus 以網路錯誤結束（不送出，只作用一次；階段 C）
 *   S8N13257.inject({})                      取消注入
 * delayToken／dropToken 只作用在「呼叫 createNewLivechatCustomer 之後的第一次 token 寫回」，
 * 頁面初次載入的 token 不受影響。
 *
 * 宿主操作（階段 B／C 的情境用）：
 *   S8N13257.rebuildIdentity()  不經 ecLogin，直接呼叫 createNewLivechatCustomer（模擬 widget 自行重建身份）
 *   S8N13257.clearEcCookie()    只刪 gaOWCustomerId，保留 livechat token（模擬 EC cookie 過期或被清掉）
 *   S8N13257.flowStart(name, ecCustomerId) / flowEnd(start, result)
 *     標記宿主的複合流程（O1–O3：同頁「登出 → 登入 B」），analyze().logoutFlows 依此判定
 *
 * 證據檔含完整的 staging livechat token，只能留在本機、不可貼到外部；Console 輸出一律遮罩。
 */
(function () {
  if (window.S8N13257) {
    return;
  }

  var VERSION = '2026-10-29';
  var TIMELINE_STORE = 's8n13257.timeline';
  var INJECT_STORE = 's8n13257.inject';
  var TOKEN_COOKIE = 'super8_customer_token';
  var EC_COOKIE = 'gaOWCustomerId';
  // EC 會員資料（姓名、電話）。只記有沒有，不記內容
  var PROFILE_COOKIE = 'gaOWCustomerProfile';
  // O1–O3 流程判定：流程結束後多久的 widget token 算「最終 token」
  var FLOW_SETTLE_MS = 3000;
  var WATCHED_URL = /\/ec\/customer\/mapping|\/checkBindStatus|\/ga4_event\/domain\/check_pass|\/ec\/retargeting\/orgEnabled|\/live_chat\/check_pass/;

  function load(key, fallback) {
    try {
      var raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      // sessionStorage 不可用時只保留記憶體內的紀錄
    }
  }

  // 與 MA 的 gaGetCookie 相同：不做 decode，才能和 mapping body 逐字比對
  function readCookie(name) {
    var parts = document.cookie.split(';');
    for (var i = 0; i < parts.length; i += 1) {
      var c = parts[i].replace(/^\s+/, '');
      if (c.indexOf(name + '=') === 0) {
        return c.substring(name.length + 1);
      }
    }
    return '';
  }

  function mask(v) {
    if (!v) {
      return v === '' ? '(空)' : v;
    }
    v = String(v);
    return v.length <= 8 ? v.slice(0, 2) + '…' : v.slice(0, 6) + '…' + v.slice(-2);
  }

  var timeline = load(TIMELINE_STORE, []);
  var pageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // createNewLivechatCustomer 被呼叫、但新 token 還沒寫回時為 true；故障注入只作用在這段
  var pendingRotation = false;

  function log(type, data) {
    var ev = {
      t: Date.now(),
      page: pageId,
      path: location.pathname + location.search,
      type: type,
      data: data || {},
    };
    timeline.push(ev);
    save(TIMELINE_STORE, timeline);
    if (window.S8N13257_QUIET !== true) {
      console.debug('[S8N-13257]', type, data || '');
    }
    return ev;
  }

  // probe 包裝過的函式取回原始版本，版本偵測要看 MA 的原始碼
  function original(fn) {
    return fn && fn.__s8n13257Orig ? fn.__s8n13257Orig : fn;
  }

  function buildInfo() {
    var cleanup = window.gaEcLogoutCleanup;
    var logout = original(window.ecLogout);
    return {
      maLoaded: typeof window.ecLogin === 'function',
      livechatLoaded: typeof window.createNewLivechatCustomer === 'function',
      hasIdentityWait: typeof window.gaWaitForLivechatIdentityChange === 'function',
      hasRotationFailed: typeof cleanup === 'function' && String(cleanup).indexOf('rotationFailed') >= 0,
      // 階段 B：setGaLivechatConnect 會看 EC 登入狀態補送 mapping
      hasConnectReadyRemap:
        typeof window.setGaLivechatConnect === 'function' && String(window.setGaLivechatConnect).indexOf('checkEcCustStatus') >= 0,
      // O1–O3：ecLogout 等新身份寫回才 resolve（gaPendingLogout 同時給 ecLogin 等同頁的登出）
      hasLogoutIdentityWait: typeof logout === 'function' && String(logout).indexOf('gaPendingLogout') >= 0,
    };
  }

  /* ---------------- cookie 輪詢 ---------------- */

  var last = { token: readCookie(TOKEN_COOKIE), ec: readCookie(EC_COOKIE) };
  log('page_load', { href: location.href, token: last.token, ecCustomerId: last.ec, probe: VERSION });

  setInterval(function () {
    var token = readCookie(TOKEN_COOKIE);
    var ec = readCookie(EC_COOKIE);
    if (token !== last.token) {
      log('cookie_token', { from: last.token, to: token });
      last.token = token;
    }
    if (ec !== last.ec) {
      log('cookie_ec', { from: last.ec, to: ec });
      last.ec = ec;
    }
  }, 50);

  /* ---------------- XHR 攔截 ---------------- */

  // mapping 的送出來源：ecLogin 自己的 gaInitData、頁面載入時 S8_ma_initMa 的 gaInitData，
  // 以及階段 B 的 connectReady 補送（setGaLivechatConnect）。
  // init 與 ecLogin 可能落在同一個 ecLogin 時間窗內，時間判斷分不出來，所以優先看呼叫堆疊
  // （V8 會帶上 await 的 async 呼叫者）。判斷依據寫在 sourceBasis：
  //   stack   送出當下的呼叫堆疊
  //   queue   階段 B 的 mapping 排隊（gaEnqueueEcMapping → .then → gaSendEcMapping）：.then 之後
  //           V8 的堆疊斷掉，改在排隊當下看堆疊，再依佇列順序對應到實際送出的 gaSendEcMapping
  //   unknown 兩者都判斷不出；另外附 sourceByTiming（依時序推測，只供參考，不當作來源）
  function stackSource(stack) {
    if (/S8_ma_initMa/.test(stack)) {
      return 'init';
    }
    if (/setGaLivechatConnect/.test(stack)) {
      return 'connectReady';
    }
    if (/\becLogin\b/.test(stack)) {
      return 'ecLogin';
    }
    return 'unknown';
  }

  function currentStack() {
    try {
      return String(new Error().stack || '');
    } catch (e) {
      return '';
    }
  }

  // 階段 B：排隊當下判斷來源，依序交給實際執行的 gaSendEcMapping
  var pendingSendSources = [];
  var activeSend = null;

  function timingSource(ecCustomerId) {
    var pageEvents = timeline.filter(function (e) {
      return e.page === pageId;
    });
    var now = Date.now();
    var inFlight = pageEvents.some(function (e) {
      if (e.type !== 'ecLogin_start' || String(e.data.ecCustomerId) !== String(ecCustomerId)) {
        return false;
      }
      return !pageEvents.some(function (x) {
        return x.type === 'ecLogin_end' && x.data.startedAt === e.t;
      });
    });
    if (inFlight) {
      return 'ecLogin';
    }
    var lastMapping = 0;
    var lastReady = 0;
    pageEvents.forEach(function (e) {
      if (e.type === 'xhr_send' && /\/ec\/customer\/mapping/.test(e.data.url)) {
        lastMapping = e.t;
      }
      if (e.type === 'widget_connectReady' && e.data.status === true) {
        lastReady = e.t;
      }
    });
    if (lastReady && lastReady >= lastMapping && now - lastReady <= 15000) {
      return 'connectReady';
    }
    var anyLogin = pageEvents.some(function (e) {
      return e.type === 'ecLogin_start';
    });
    return anyLogin ? 'unknown' : 'init';
  }

  function mappingSource(ecCustomerId) {
    var s = stackSource(currentStack());
    if (s !== 'unknown') {
      return { source: s, basis: 'stack' };
    }
    if (activeSend) {
      return { source: activeSend.source, basis: 'queue' };
    }
    return { source: 'unknown', basis: 'unknown', byTiming: timingSource(ecCustomerId) };
  }

  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__s8n13257 = { method: method, url: String(url) };
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var meta = this.__s8n13257;
    if (meta && WATCHED_URL.test(meta.url)) {
      var parsed = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch (e) {
        parsed = null;
      }
      var u = new URL(meta.url, location.href);
      var query = {};
      u.searchParams.forEach(function (v, k) {
        if (k !== 'encryptedOrgId') {
          query[k] = v;
        }
      });
      var sendData = { method: meta.method, url: u.pathname, query: query, body: parsed };
      if (/\/ec\/customer\/mapping/.test(u.pathname)) {
        var src = mappingSource(parsed && parsed.ecCustomerId);
        sendData.source = src.source;
        sendData.sourceBasis = src.basis;
        if (src.byTiming) {
          sendData.sourceByTiming = src.byTiming;
        }
      }
      var inj = /\/checkBindStatus/.test(u.pathname) ? load(INJECT_STORE, {}) : {};
      if (inj.failCheckBind) {
        sendData.injected = 'networkError';
      }
      var sent = log('xhr_send', sendData);
      this.addEventListener('loadend', function () {
        var res = null;
        try {
          res = JSON.parse(this.responseText);
        } catch (e) {
          res = null;
        }
        log('xhr_done', { url: u.pathname, status: this.status, response: res, sentAt: sent.t });
      });
      if (inj.failCheckBind) {
        // 只作用一次：不送出，改以網路錯誤結束（MA 的 gaMakeRequest 走 onerror → reject）
        var rest = {};
        Object.keys(inj).forEach(function (k) {
          if (k !== 'failCheckBind') {
            rest[k] = inj[k];
          }
        });
        save(INJECT_STORE, rest);
        log('inject_fired', { kind: 'failCheckBind', url: u.pathname });
        var xhr = this;
        setTimeout(function () {
          xhr.dispatchEvent(new ProgressEvent('error'));
          xhr.dispatchEvent(new ProgressEvent('loadend'));
        }, 0);
        return undefined;
      }
    }
    return origSend.apply(this, arguments);
  };

  /* ---------------- widget 訊息觀察與故障注入 ---------------- */

  // LiveChat 的 handler 只檢查 event.source 是不是 widget iframe；重新派送時沿用原本的 source。
  // 用 capture 註冊，在 LiveChat 自己的 listener 之前執行。
  var redispatched = typeof WeakSet === 'function' ? new WeakSet() : null;

  window.addEventListener(
    'message',
    function (event) {
      var d = event.data;
      if (!d || d.target !== 'eightChat' || (redispatched && redispatched.has(event))) {
        return;
      }
      var opts = d.options || {};
      if (d.command === 'connectReady') {
        log('widget_connectReady', { status: opts.status, token: opts.customerToken });
        return;
      }
      if (d.command !== 'notifySetCookie' || opts.name !== TOKEN_COOKIE) {
        return;
      }

      var inj = load(INJECT_STORE, {});
      var affected = pendingRotation && opts.value && opts.value !== readCookie(TOKEN_COOKIE);
      log('widget_setToken', {
        value: opts.value,
        injected: affected ? (inj.dropToken ? 'drop' : inj.delayTokenMs || 0) : 0,
      });
      if (!affected) {
        return;
      }
      pendingRotation = false;

      if (inj.dropToken) {
        event.stopImmediatePropagation();
        return;
      }
      if (inj.delayTokenMs > 0 && redispatched) {
        event.stopImmediatePropagation();
        var init = { data: d, origin: event.origin, source: event.source };
        setTimeout(function () {
          var again = new MessageEvent('message', init);
          redispatched.add(again);
          window.dispatchEvent(again);
          log('widget_setToken_released', { value: opts.value, afterMs: inj.delayTokenMs });
        }, inj.delayTokenMs);
      }
    },
    true,
  );

  /* ---------------- 包裝 SDK 函式 ---------------- */

  // launch.js 用頂層 function 宣告，掛在 window 上且可覆寫；
  // MA 內部用裸名稱呼叫 createNewLivechatCustomer，查找時會拿到包裝後的版本。
  function wrapWhenReady(name, makeWrapper) {
    var tries = 0;
    (function attempt() {
      var fn = window[name];
      if (typeof fn === 'function' && !fn.__s8n13257) {
        var wrapped = makeWrapper(fn);
        wrapped.__s8n13257 = true;
        wrapped.__s8n13257Orig = fn;
        window[name] = wrapped;
        log('hooked', { name: name, build: buildInfo() });
        return;
      }
      tries += 1;
      if (tries < 1200) {
        setTimeout(attempt, 50);
      }
    })();
  }

  function wrapAsync(name) {
    wrapWhenReady(name, function (orig) {
      return function () {
        var args = Array.prototype.slice.call(arguments);
        var start = log(name + '_start', {
          ecCustomerId: args[0],
          token: readCookie(TOKEN_COOKIE),
          ec: readCookie(EC_COOKIE),
        });
        var ret;
        try {
          ret = orig.apply(this, arguments);
        } catch (e) {
          log(name + '_end', { ecCustomerId: args[0], startedAt: start.t, threw: String(e && e.message) });
          throw e;
        }
        // async 函式在第一個 await 就把控制權交回來：這裡讀到的是「呼叫當下、resolve 之前」的 cookie（O3）
        log(name + '_called', { startedAt: start.t, profile: Boolean(readCookie(PROFILE_COOKIE)) });
        return Promise.resolve(ret).then(
          function (result) {
            log(name + '_end', {
              ecCustomerId: args[0],
              startedAt: start.t,
              result: result === undefined ? null : result,
              token: readCookie(TOKEN_COOKIE),
              ec: readCookie(EC_COOKIE),
              profile: Boolean(readCookie(PROFILE_COOKIE)),
            });
            return result;
          },
          function (err) {
            log(name + '_end', { ecCustomerId: args[0], startedAt: start.t, rejected: String(err && err.message) });
            throw err;
          },
        );
      };
    });
  }

  wrapAsync('ecLogin');
  wrapAsync('ecLogout');

  // 階段 B 的 mapping 佇列（計畫 Task 6）。A 版本沒有這兩個函式，等不到就放棄，不影響其他觀察。
  // S8N13257_NO_QUEUE_HOOK 只給離線自我測試用：關掉佇列對應，驗證時序備援
  var queueHook = window.S8N13257_NO_QUEUE_HOOK !== true;
  queueHook && wrapWhenReady('gaEnqueueEcMapping', function (orig) {
    return function () {
      pendingSendSources.push(stackSource(currentStack()));
      return orig.apply(this, arguments);
    };
  });
  queueHook && wrapWhenReady('gaSendEcMapping', function (orig) {
    return function () {
      var mine = { source: pendingSendSources.length ? pendingSendSources.shift() : 'unknown' };
      activeSend = mine;
      var ret;
      try {
        ret = orig.apply(this, arguments);
      } catch (e) {
        activeSend = null;
        throw e;
      }
      var clear = function () {
        if (activeSend === mine) {
          activeSend = null;
        }
      };
      Promise.resolve(ret).then(clear, clear);
      return ret;
    };
  });

  wrapWhenReady('createNewLivechatCustomer', function (orig) {
    return function () {
      var inj = load(INJECT_STORE, {});
      log('rotation_call', { token: readCookie(TOKEN_COOKIE), injected: inj.failRotation ? 'throw' : null });
      if (inj.failRotation) {
        var err = new TypeError("Cannot read properties of null (reading 'contentWindow') [S8N-13257 injected]");
        log('rotation_throw', { message: err.message });
        throw err;
      }
      try {
        var ret = orig.apply(this, arguments);
        pendingRotation = true;
        return ret;
      } catch (e) {
        log('rotation_throw', { message: String(e && e.message) });
        throw e;
      }
    };
  });

  /* ---------------- 判定 ---------------- */

  function analyze() {
    var rows = [];
    var rotatedAway = [];
    var starts = timeline.filter(function (e) {
      return e.type === 'ecLogin_start';
    });

    starts.forEach(function (start, idx) {
      var end = null;
      for (var i = 0; i < timeline.length; i += 1) {
        var e = timeline[i];
        if (e.type === 'ecLogin_end' && e.data.startedAt === start.t) {
          end = e;
          break;
        }
      }
      var until = end ? end.t : Infinity;
      var inWindow = timeline.filter(function (e) {
        return e.t >= start.t && e.t <= until;
      });
      var rotation = inWindow.find(function (e) {
        return e.type === 'rotation_call';
      });
      var rotationThrow = inWindow.find(function (e) {
        return e.type === 'rotation_throw';
      });
      var prevToken = rotation ? rotation.data.token : start.data.token;
      var newTokenEv = rotation
        ? inWindow.find(function (e) {
            return e.type === 'cookie_token' && e.t >= rotation.t && e.data.to && e.data.to !== prevToken;
          })
        : null;
      var mappings = inWindow.filter(function (e) {
        return e.type === 'xhr_send' && /\/ec\/customer\/mapping/.test(e.data.url) && e.data.body && String(e.data.body.ecCustomerId) === String(start.data.ecCustomerId);
      });
      var result = end ? end.data.result || end.data.threw || end.data.rejected || null : null;
      var status = result && result.status;
      var error = result && result.error;
      var mapped = mappings.map(function (m) {
        return m.data.body.customerId;
      });

      var verdict = 'INFO';
      var note = '';
      if (!end) {
        verdict = 'PENDING';
        note = 'ecLogin 尚未結束';
      } else if (rotation && rotationThrow) {
        if (error === 'identity not ready' && mappings.length === 0) {
          verdict = 'PASS';
          note = '輪換失敗 → 不送 mapping';
        } else {
          verdict = 'FAIL';
          note = '輪換失敗卻仍送 mapping 或回 success（修正前的行為）';
        }
      } else if (rotation) {
        rotatedAway.push({ token: prevToken, t: rotation.t });
        if (status === 'success') {
          var stale = mapped.filter(function (c) {
            return c === prevToken;
          });
          if (mappings.length === 0) {
            verdict = 'FAIL';
            note = '回 success 但沒送 mapping';
          } else if (stale.length) {
            verdict = 'FAIL';
            note = 'mapping 帶到輪換前的舊身份（本單的 bug）';
          } else if (newTokenEv && mapped.every(function (c) {
            return c === newTokenEv.data.to;
          })) {
            verdict = 'PASS';
            note = 'mapping 帶新身份';
          } else {
            verdict = 'FAIL';
            note = 'mapping 的身份不是這次輪換寫回的 token';
          }
        } else if (error === 'identity not ready') {
          verdict = mappings.length === 0 && !end.data.ec ? 'PASS' : 'FAIL';
          note = verdict === 'PASS' ? '逾時 → 不送 mapping、不留 EC cookie' : '逾時卻仍送 mapping 或留下 EC cookie';
        } else if (error === 'superseded') {
          verdict = mappings.length === 0 ? 'PASS' : 'FAIL';
          note = '等待中被作廢';
        } else {
          verdict = 'WARN';
          note = '非預期結果：' + JSON.stringify(result);
        }
      } else if (status === 'success') {
        verdict = mappings.length ? 'PASS' : 'WARN';
        note = '未輪換（首次登入或舊身份未綁定），照原流程送 mapping';
      } else {
        verdict = 'INFO';
        note = '未輪換，結果：' + JSON.stringify(result);
      }

      rows.push({
        n: idx + 1,
        page: start.path,
        ecCustomerId: start.data.ecCustomerId,
        rotated: Boolean(rotation),
        rotationThrew: Boolean(rotationThrow),
        prevToken: prevToken,
        newToken: newTokenEv ? newTokenEv.data.to : null,
        tokenWritebackMs: rotation && newTokenEv ? newTokenEv.t - rotation.t : null,
        mappingCustomerIds: mapped,
        result: result,
        durationMs: end ? end.t - start.t : null,
        verdict: verdict,
        note: note,
      });
    });

    // 任何時候 mapping 帶到「已經被輪換掉」的身份都是錯綁，不論是哪一次 ecLogin 送出的
    var crossChecks = [];
    timeline.forEach(function (e) {
      if (e.type !== 'xhr_send' || !/\/ec\/customer\/mapping/.test(e.data.url) || !e.data.body) {
        return;
      }
      rotatedAway.forEach(function (r) {
        if (e.t > r.t && e.data.body.customerId === r.token) {
          crossChecks.push({ at: e.t, ecCustomerId: e.data.body.ecCustomerId, customerId: r.token });
        }
      });
    });

    var flows = analyzeLogoutFlows();
    var verdicts = rows.map(function (r) {
      return r.verdict;
    }).concat(flows.map(function (f) {
      return f.verdict;
    }));
    var overall = 'NO_DATA';
    if (rows.length) {
      overall = verdicts.indexOf('FAIL') >= 0 || crossChecks.length ? 'FAIL' : verdicts.indexOf('PENDING') >= 0 ? 'PENDING' : 'PASS';
    }
    return {
      overall: overall,
      build: buildInfo(),
      inject: load(INJECT_STORE, {}),
      rows: rows,
      staleMappings: crossChecks,
      logoutFlows: flows,
    };
  }

  // 某時間點的 widget token：時間線上最後一次 page_load／cookie_token 的值（cookie 每 50ms 輪詢一次）
  function tokenAt(t) {
    var v = null;
    timeline.forEach(function (e) {
      if (e.t > t) {
        return;
      }
      if (e.type === 'page_load') {
        v = e.data.token;
      } else if (e.type === 'cookie_token') {
        v = e.data.to;
      }
    });
    return v;
  }

  // O1–O3：同頁「登出 → 登入 B」流程（host.html 的 awaitLogoutLoginB／fireLogoutLoginB）。
  // 一個流程 = host_flow_start 到 host_flow_end（ecLogin(B) 結束）。PASS 要全部成立：
  //   rotation_call 次數 = 1（登出建一次新身份，登入 B 不再輪換）
  //   B 的 mapping token = 最終 widget token（流程結束 3 秒後的 cookie）
  //   登出呼叫當下（resolve 前）與登出後，gaOWCustomerProfile 都不存在
  //   登入 B 回 success
  function analyzeLogoutFlows() {
    var out = [];
    timeline.forEach(function (start) {
      if (start.type !== 'host_flow_start') {
        return;
      }
      var end = null;
      for (var i = 0; i < timeline.length; i += 1) {
        if (timeline[i].type === 'host_flow_end' && timeline[i].data.startedAt === start.t) {
          end = timeline[i];
          break;
        }
      }
      var until = end ? end.t : Infinity;
      var inWindow = timeline.filter(function (e) {
        return e.t >= start.t && e.t <= until && e.page === start.page;
      });
      var b = String(start.data.ecCustomerId);
      var rotations = inWindow.filter(function (e) {
        return e.type === 'rotation_call';
      });
      var logoutCalled = inWindow.find(function (e) {
        return e.type === 'ecLogout_called';
      });
      var logoutEnd = logoutCalled
        ? inWindow.find(function (e) {
            return e.type === 'ecLogout_end' && e.data.startedAt === logoutCalled.data.startedAt;
          })
        : null;
      var mapped = inWindow
        .filter(function (e) {
          return e.type === 'xhr_send' && /\/ec\/customer\/mapping/.test(e.data.url) && e.data.body && String(e.data.body.ecCustomerId) === b;
        })
        .map(function (e) {
          return e.data.body.customerId;
        });
      // 登出輪換後第一次寫回的新 token，和登出 resolve 的先後（O1：登出要晚於寫回）
      var firstRotation = rotations[0];
      var newTokenEv = firstRotation
        ? inWindow.find(function (e) {
            return e.type === 'cookie_token' && e.t >= firstRotation.t && e.data.to && e.data.to !== firstRotation.data.token;
          })
        : null;
      var settled = end ? Date.now() >= end.t + FLOW_SETTLE_MS : false;
      var finalWidgetToken = settled ? tokenAt(end.t + FLOW_SETTLE_MS) : null;
      var result = end ? end.data.result : null;
      var f = {
        flow: start.data.name,
        page: start.path,
        ecCustomerId: b,
        rotationCalls: rotations.length,
        mappingTokens: mapped,
        finalWidgetToken: finalWidgetToken,
        mappingMatchesFinal: settled ? mapped.length > 0 && mapped.every(function (c) {
          return c === finalWidgetToken;
        }) : null,
        profileAfterLogoutCall: logoutCalled ? logoutCalled.data.profile : null,
        profileAfterLogout: logoutEnd ? logoutEnd.data.profile : null,
        logoutEndedAfterNewToken: logoutEnd && newTokenEv ? logoutEnd.t >= newTokenEv.t : null,
        logoutMs: logoutEnd ? logoutEnd.t - logoutCalled.data.startedAt : null,
        result: result,
        verdict: 'PENDING',
        note: '',
      };
      if (!end) {
        f.note = '流程尚未結束';
      } else if (!settled) {
        f.note = '流程結束未滿 3 秒，最終 widget token 還不能判定';
      } else {
        var fails = [];
        if (f.rotationCalls !== 1) {
          fails.push('rotation_call ' + f.rotationCalls + ' 次');
        }
        if (!f.mappingMatchesFinal) {
          fails.push(mapped.length ? 'B 的 mapping token ≠ 最終 widget token' : 'B 沒有送 mapping');
        }
        if (f.profileAfterLogoutCall !== false || f.profileAfterLogout !== false) {
          fails.push('登出後 profile cookie 仍在');
        }
        if (!result || result.status !== 'success') {
          fails.push('登入 B 沒有成功：' + JSON.stringify(result));
        }
        f.verdict = fails.length ? 'FAIL' : 'PASS';
        f.note = fails.length ? fails.join('；') : '輪換 1 次、mapping 帶最終 token、登出即刪 profile';
      }
      out.push(f);
    });
    return out;
  }

  window.S8N13257 = {
    version: VERSION,
    report: function () {
      var r = analyze();
      console.log('%cS8N-13257 判定：' + r.overall, 'font-weight:bold;font-size:14px');
      console.log('MA build', r.build, '注入', r.inject);
      console.table(
        r.rows.map(function (x) {
          return {
            '#': x.n,
            ecLogin: x.ecCustomerId,
            輪換: x.rotated ? (x.rotationThrew ? '拋錯' : '是') : '否',
            舊token: mask(x.prevToken),
            新token: mask(x.newToken),
            寫回ms: x.tokenWritebackMs,
            mapping: x.mappingCustomerIds.map(mask).join(', '),
            結果: JSON.stringify(x.result),
            判定: x.verdict,
            說明: x.note,
          };
        }),
      );
      if (r.logoutFlows.length) {
        console.table(
          r.logoutFlows.map(function (f) {
            return {
              流程: f.flow,
              'rotation_call 次數': f.rotationCalls,
              'B 的 mapping token': f.mappingTokens.map(mask).join(', '),
              '最終 widget token（結束 3 秒後）': mask(f.finalWidgetToken),
              'B 的 mapping token = 最終 widget token': f.mappingMatchesFinal,
              '登出呼叫當下 profile cookie': f.profileAfterLogoutCall,
              '登出後 profile cookie': f.profileAfterLogout,
              判定: f.verdict,
              說明: f.note,
            };
          }),
        );
      }
      if (r.staleMappings.length) {
        console.warn('mapping 帶到已輪換掉的身份：', r.staleMappings.map(function (s) {
          return { ecCustomerId: s.ecCustomerId, customerId: mask(s.customerId) };
        }));
      }
      return r;
    },
    analyze: analyze,
    exportJSON: function () {
      var payload = {
        probe: VERSION,
        exportedAt: new Date().toISOString(),
        origin: location.origin,
        analysis: analyze(),
        timeline: timeline,
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 's8n-13257-evidence-' + Date.now() + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      return payload;
    },
    inject: function (opts) {
      save(INJECT_STORE, opts || {});
      log('inject', opts || {});
      return opts || {};
    },
    // 階段 B：不經 ecLogin 讓 widget 換身份（呼叫的是包裝後的 createNewLivechatCustomer，會留下 rotation_call）
    rebuildIdentity: function () {
      log('host_rebuild', { token: readCookie(TOKEN_COOKIE), ec: readCookie(EC_COOKIE) });
      window.createNewLivechatCustomer();
    },
    // 階段 C：只刪 EC cookie，保留 livechat token；與 MA gaDeleteCookie 相同寫法
    // O1–O3 的宿主流程標記：start 回傳的事件要原樣交給 flowEnd
    flowStart: function (name, ecCustomerId) {
      return log('host_flow_start', { name: name, ecCustomerId: ecCustomerId, token: readCookie(TOKEN_COOKIE) });
    },
    flowEnd: function (start, result) {
      return log('host_flow_end', { name: start.data.name, startedAt: start.t, result: result === undefined ? null : result });
    },
    clearEcCookie: function () {
      log('host_clear_ec', { token: readCookie(TOKEN_COOKIE), ec: readCookie(EC_COOKIE) });
      document.cookie = EC_COOKIE + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;';
    },
    clear: function () {
      timeline = [];
      save(TIMELINE_STORE, timeline);
      save(INJECT_STORE, {});
      log('cleared', {});
    },
    cookies: function () {
      return { token: readCookie(TOKEN_COOKIE), ecCustomerId: readCookie(EC_COOKIE) };
    },
    mask: mask,
    timeline: function () {
      return timeline.slice();
    },
  };
})();
