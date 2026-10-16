// ==UserScript==
// @name         CPQ Auto — Projekt-Autopilot
// @namespace    local.chatgpt.promptqueue
// @version      3.2.12
// @description  V3.2.12: Sichere automatische Tampermonkey-Updates über öffentliche Installationsdatei.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/Derogatary/cpq-autopilot-updates/main/cpq-autopilot.user.js
// @downloadURL  https://raw.githubusercontent.com/Derogatary/cpq-autopilot-updates/main/cpq-autopilot.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = '3.2.12-tampermonkey-update';
  if (document.querySelector('#cpq-v3-host')) return;

  const KEY = 'chatgpt-prompt-queue:v3.1auto';
  const SCOPE_KEY = 'cpq:chat-optin:v3.1auto';
  const CHAT_CONFIG_PREFIX = 'cpq:chat-settings:v3.2.6:';
  const LEDGER_PREFIX = 'cpq:v3.2:run:';
  const LEDGER_MAX = 60;
  const AUTOMATED = new Set(['auto', 'continue-only', 'project']);
  const MAX_STEPS = 50;
  const MAX_AUTO_MESSAGES = 50;
  const TIMEOUT_MS = 15 * 60 * 1000;
  // Explicit tool activity can outlive model thinking and the normal reply timer.
  // Still fail closed after an upper bound rather than waiting indefinitely.
  const TOOL_MAX_WAIT_MS = 60 * 60 * 1000;
  const TOOL_AFTER_QUIET_MS = 20 * 1000;
  const SEND_TIMEOUT_MS = 30 * 1000;
  const CLICK_TIMEOUT_MS = 30 * 1000;
  const MIN_SEND_GAP_MS = 8000;
  const POLL_MS = 500;
  const RESUME_CHECK_MS = 2500;
  const SCHEDULER_GAP_MS = 45000;
  const AUTO_CONTINUE_QUIET_MS = 2200;
  const SEND_READY_WAIT_MS = 8000;
  const SEND_ACK_WAIT_MS = 8000;
  const ACK_SCHEDULER_GAP_MS = 2500; // Groessere Timer-Spruenge sind kein sofortiger Versandfehler
  const BOOTSTRAP_IDLE_MS = 1800; // Nur nach ausdruecklich bestaetigtem Start
  const DEFAULT_PROJECT_PROMPT = 'Weiter. Bearbeite den naechsten konkret ausfuehrbaren, noch offenen Schritt der bisherigen Aufgabe. Wiederhole nichts Erledigtes. Falls alles abgeschlossen ist, erklaere klar, dass keine Schritte mehr offen sind. Optional: [[CPQ:FERTIG]] als letzte Zeile.';

  const EXAMPLES = {
    custom: '',
    book: [
      'Fasse den bisherigen Stand unseres Buchprojekts zusammen. Unterscheide beschlossene Fakten, Vorschläge und offene Fragen.',
      'Prüfe Genreversprechen, Spannungsbogen, Figurenentwicklung, Progression und Kontinuität. Priorisiere die wichtigsten Schwächen.',
      'Erarbeite konkrete, mit den vorhandenen Festlegungen verträgliche Verbesserungen und begründe die Entscheidungen.',
      'Erstelle einen priorisierten Revisionsplan mit überprüfbaren Qualitätskriterien und nächsten Schreibaufgaben.'
    ].join('\n===\n'),
    software: [
      'Extrahiere Projektziel, Anforderungen, bestehende Entscheidungen, Annahmen und offene Risiken aus diesem Chat.',
      'Erarbeite und vergleiche praktikable Lösungswege nach Aufwand, Kosten, Wartbarkeit und Sicherheit.',
      'Erstelle einen Implementierungsplan in überprüfbaren Etappen mit Tests und klaren Abnahmekriterien.',
      'Prüfe den Plan auf Lücken, technische Risiken und unnötige Komplexität. Gib die überarbeitete Fassung aus.'
    ].join('\n===\n'),
    single: 'Analysiere die aktuelle Aufgabe systematisch. Nenne Annahmen, löse die Kernfrage und liefere überprüfbare nächste Schritte.'
  };

  const safeSettings = { mode: 'review', waitSeconds: 12, autoContinue: true, maxContinue: 2, maxProject: 5, projectClick: false, projectPrompt: DEFAULT_PROJECT_PROMPT, fallbackMissingMarker: true, fallbackContinueText: true, loopGuard:true, checkpointEvery:0, runStrategy:'count', durationHours:0 };
  let initial = { text: '', ...safeSettings };
  try {
    const saved = typeof GM_getValue === 'function' ? GM_getValue(KEY, '') : '';
    const loaded = JSON.parse(saved || localStorage.getItem(KEY) || localStorage.getItem('chatgpt-prompt-queue:v3') || localStorage.getItem('chatgpt-prompt-queue:v2') || '{}');
    if (typeof loaded.text === 'string') initial.text = loaded.text;
    if (['review', 'auto', 'continue-only', 'diagnose', 'project'].includes(loaded.mode)) initial.mode = loaded.mode;
    if ([8, 12, 20].includes(Number(loaded.waitSeconds))) initial.waitSeconds = Number(loaded.waitSeconds);
    if (typeof loaded.autoContinue === 'boolean') initial.autoContinue = loaded.autoContinue;
    if ([1, 2, 3].includes(Number(loaded.maxContinue))) initial.maxContinue = Number(loaded.maxContinue);
    if ([1, 3, 5, 10, 15, 20, 30, 50].includes(Number(loaded.maxProject))) initial.maxProject = Number(loaded.maxProject);
    if (typeof loaded.projectClick === 'boolean') initial.projectClick = loaded.projectClick;
    if (typeof loaded.fallbackMissingMarker === 'boolean') initial.fallbackMissingMarker = loaded.fallbackMissingMarker;
    if (typeof loaded.fallbackContinueText === 'boolean') initial.fallbackContinueText = loaded.fallbackContinueText;
    if (typeof loaded.projectPrompt === 'string' && loaded.projectPrompt.length < 2000) initial.projectPrompt = loaded.projectPrompt;
    if (typeof loaded.loopGuard === 'boolean') initial.loopGuard = loaded.loopGuard;
    if ([0,5,10,20].includes(Number(loaded.checkpointEvery))) initial.checkpointEvery = Number(loaded.checkpointEvery);
    if (['count','marker'].includes(loaded.runStrategy)) initial.runStrategy = loaded.runStrategy;
    if ([0,1,3,8].includes(Number(loaded.durationHours))) initial.durationHours = Number(loaded.durationHours);
  } catch (_) { /* Ohne Speicher nutzbar */ }

  const host = document.createElement('div');
  host.id = 'cpq-v3-host';
  host.style.cssText = 'position:fixed;top:12px;right:100px;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all:initial; color-scheme:dark; }
      * { box-sizing:border-box; }
      button, textarea, input, select { font:inherit; }
      button { cursor:pointer; }
      .launch { background:#255bb2;color:white;border:1px solid #86a7ee;border-radius:999px;padding:7px 13px;font:700 12px system-ui;white-space:nowrap;max-width:145px;box-shadow:0 5px 18px #0005; }
      .launch[data-state="run"] {background:#177245;border-color:#8cddae;}
      .launch[data-state="done"] {background:#a76e0e;border-color:#ffdc70;color:white;}
      .launch[data-state="halt"] {background:#a52e3e;border-color:#ff8799;}
      .launch[data-state="pause"] {background:#255bb2;border-color:#86a7ee;}
      .launch:focus-visible {outline:3px solid #fff;outline-offset:3px;}
      .panel { position:fixed;right:18px;top:52px;display:none;width:min(440px,calc(100vw - 26px));max-height:min(86vh,780px);overflow-y:auto;overflow-x:hidden; padding:0 15px 15px;background:#161e2b;border:1px solid #57667f;border-radius:15px;color:#f4f6fa;font:13px/1.45 system-ui;box-shadow:0 14px 45px #0008; }
      .panel.open { display:block; }
      header { position:sticky;top:0;z-index:40;display:flex;justify-content:space-between;align-items:center;gap:10px;margin:0 -15px 8px;padding:12px 15px;background:#161e2b;border-bottom:1px solid #43536c;box-shadow:0 3px 9px #0004; }
      header strong { font-size:15px; }
      .close { border:0;background:#313d52;color:white;border-radius:6px;padding:5px 11px;font-size:20px;line-height:1.1;flex:none; }
      .header-actions { display:flex;align-items:center;gap:7px;flex:none; }
      .header-quick-start { border:1px solid #90bcff;background:#2469cc;color:white;border-radius:7px;padding:8px 10px;font-weight:700;white-space:nowrap;line-height:1.2; }
      .header-quick-start:focus-visible { outline:2px solid white;outline-offset:2px; }
      label { display:block;font-weight:600;margin:9px 0 4px; }
      textarea, select { width:100%;border:1px solid #5c6c82;border-radius:8px;background:#263247;color:#fafafa;padding:8px; }
      textarea { min-height:130px;resize:vertical;line-height:1.5; }
      .row { display:flex;gap:9px;align-items:center; }
      .row > div { flex:1;min-width:0; }
      .checkbox { display:flex;gap:9px;align-items:center;font-weight:400;margin:11px 0 5px; }
      .checkbox input { width:16px;height:16px;accent-color:#6599fa; }
      .buttons { display:flex;flex-wrap:wrap;gap:7px;margin-top:12px; }
      .buttons button { border-radius:7px;border:1px solid #778aa4;background:#364963;color:white;padding:8px 10px; }
      .buttons .primary { background:#2265c8;border-color:#78abfa; }
      button:disabled { cursor:not-allowed;opacity:.45; }
      .status { background:#273346;border:1px solid #566a86;border-radius:10px;margin-top:12px;padding:10px; }
      #state { font-weight:600; }
      #detail { margin:5px 0;color:#d0d8e4;overflow-wrap:anywhere; }
      #progress { color:#9fc6ff;font-variant-numeric:tabular-nums; }
      #diagnostics { margin-top:9px;padding:7px;border-radius:6px;background:#101826;color:#c8d4e7;font:12px/1.55 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere; }
      .note { margin:9px 0 0;color:#c2cfe0;font-size:11px; }
      .warning { color:#ffc88b; }
      [hidden] { display:none !important; }
      .scope {border:1px solid #7091c2;border-radius:9px;padding:10px;background:#1e2c42;margin:12px 0;}
      .scope-actions {display:flex;gap:7px;flex-wrap:wrap;margin-top:9px;}
      .scope-actions button {padding:7px 9px;border:1px solid #8ca3c8;color:#fff;border-radius:7px;background:#35517a;}
      .scope-actions button.danger {background:#843146;border-color:#d5a1ab;}
      .scope-small {font-size:11px;overflow-wrap:anywhere;color:#bfd1e9;}
      .preflight {border:1px solid #a7c2f2;background:#243450;padding:10px;border-radius:9px;margin-top:12px;}
      .preflight pre {overflow:auto;max-height:180px;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,monospace;color:#eaf2ff;}
      .preflight strong {color:#dbe9ff;}
    </style>
    <button id="launch" class="launch" type="button" data-state="idle" title="CPQ öffnen">CPQ</button>
    <section class="panel" id="panel" aria-label="ChatGPT Prompt Queue">
      <header><strong>CPQ Auto 3.2.12</strong><div class="header-actions"><button id="quickStart" class="header-quick-start" type="button" title="Letzte Einstellungen für diesen Chat übernehmen. Die Startbestätigung bleibt erforderlich.">Schnellstart</button><button id="close" class="close" type="button" aria-label="Fenster minimieren">×</button></div></header>
      <section class="preflight" id="preflight" hidden aria-label="Bestätigung der Automatik">
        <strong>Vor automatischer Ausführung bestätigen</strong>
        <p id="preflightSummary">Bitte prüfe die geplanten Aktionen.</p>
        <pre id="preflightText"></pre>
        <p class="note warning">Du gibst die aufgeführten Nachrichten/Aktionen für diesen einen Durchlauf frei. Kein Umgehen von ChatGPT-Limits.</p>
        <div class="buttons"><button id="confirmStart" class="primary" type="button">Diese Aktionen freigeben</button><button id="cancelStart" type="button">Abbrechen</button></div>
      </section>
      <section class="scope" id="scopeBox" aria-label="Freigabe für diesen Chat">
        <strong>Automatik nur in freigegebenen Chats</strong>
        <p id="scopeText" class="scope-small">Freigabe wird geladen …</p>
        <div class="scope-actions"><button id="globalSwitch" type="button">Global einschalten</button><button id="chatSwitch" type="button">Diesen Chat freigeben</button></div>
        <p class="scope-small">Eine Freigabe gilt nur für die exakte Chat-URL. Neue Chats bleiben gesperrt. Jeder Automatiklauf braucht eine eigene Startbestätigung und eine browserweite Sperre pro Chat.</p>
      </section>
      <label for="preset">Vorlage</label>
      <select id="preset"><option value="custom">Eigene Prompts</option><option value="book">Buchprojekt (4 Schritte)</option><option value="software">Softwareprojekt (4 Schritte)</option><option value="single">Einzelner Prompt</option></select>
      <label for="queue">Prompt-Reihe (jeweils mit === trennen)</label>
      <textarea id="queue" spellcheck="true" placeholder="Erster Prompt …\n===\nZweiter Prompt …"></textarea>
      <label for="mode">Modus</label>
      <select id="mode"><option value="review">Mit Freigabe nach jeder Antwort</option><option value="auto">Automatisch nächsten Prompt senden</option><option value="continue-only">Auto-Weiter: Button oder Nachricht</option><option value="project">Projekt-Autopilot (Marker optional)</option><option value="diagnose">Diagnose (sendet und klickt nichts)</option></select>
      <div class="row">
        <div><label for="stability">Ruhephase nach Antwort</label><select id="stability"><option value="8">8 Sekunden</option><option value="12">12 Sekunden</option><option value="20">20 Sekunden</option></select></div>
        <div><label for="maxContinue">Maximal „Weiter“</label><select id="maxContinue"><option value="1">1× je Antwort</option><option value="2">2× je Antwort</option><option value="3">3× je Antwort</option></select></div>
      </div>
      <label class="checkbox"><input id="autoContinue" type="checkbox"/> Natives „Continue generating“ automatisch klicken</label>
      <label class="checkbox"><input id="fallbackContinueText" type="checkbox"/> Wenn kein nativer Weiter-Button existiert: selbst Fortsetzungsnachricht senden (im Auto-Weiter-Modus)</label>
      <div id="projectSection">
        <label for="maxProject">Maximal automatische Fortsetzungsnachrichten pro Start (auch Auto-Weiter)</label>
        <select id="maxProject"><option value="1">1 Nachricht</option><option value="3">3 Nachrichten</option><option value="5">5 Nachrichten</option><option value="10">10 Nachrichten</option><option value="15">15 Nachrichten</option><option value="20">20 Nachrichten</option><option value="30">30 Nachrichten</option><option value="50">50 Nachrichten</option></select>
        <label for="runStrategy">Fortsetzungsziel (Projekt / Auto-Weiter)</label>
        <select id="runStrategy"><option value="count">Bis zum gewählten Nachrichtenlimit (bisheriger Standard)</option><option value="marker">Bis [[CPQ:FERTIG]] – Pakete einzeln freigeben</option></select>
        <label for="durationHours">Maximale Laufzeit dieses Starts</label>
        <select id="durationHours"><option value="0">Keine zusätzliche Zeitgrenze (Standard)</option><option value="1">1 Stunde</option><option value="3">3 Stunden</option><option value="8">8 Stunden</option></select>
        <p class="note warning">Abschlussmarker-Modus: CPQ stoppt weiterhin nach jeweils höchstens 50 Nachrichten (oder deinem kleineren Limit). Nach dem vollständig beantworteten Paket kannst du über „Letzten sicheren Stand übernehmen“ und die neue Startbestätigung das nächste Paket freigeben. Es gibt KEIN unkontrolliertes Dauersenden. Zeitlimit, Fehler, PRUEFEN, fehlende Antworten, Loop-Erkennung und manuelle Pause stoppen weiterhin.</p>
        <p class="note warning">Lange Ketten ab 15 Nachrichten können viele Nutzungsanfragen erzeugen. Das Limit gilt pro Start. Die automatische Erkennung des inhaltlichen Projektendes ist ohne [[CPQ:FERTIG]] nicht garantiert.</p>
        <label for="projectPrompt">Fortsetzungsnachricht (auch ohne Button/Marker)</label>
        <textarea id="projectPrompt" spellcheck="true" style="min-height:80px"></textarea>
        <label class="checkbox"><input id="fallbackMissingMarker" type="checkbox"/> Projektmodus: Bei fehlendem CPQ-Marker automatisch fortsetzen (bis zum Limit)</label>
        <label class="checkbox"><input id="projectClick" type="checkbox"/> Experimentell: echten „Weiter · CPQ“-Button anklicken, falls vorhanden (sonst Nachricht senden)</label>
        <p class="note warning">Ohne Marker kann das Script NICHT selbst erkennen, ob alle Projektarbeiten erledigt sind. Es setzt bis zur Obergrenze fort. [[CPQ:FERTIG]] stoppt; [[CPQ:PRUEFEN]] pausiert. Bei unbekanntem Zustand ebenfalls Pause.</p>
      </div>
      <section class="scope" aria-label="Lokaler Projektmanager">
        <strong>Projektmanager · nur lokal</strong>
        <label for="projectLabel">Projektname (optional)</label>
        <input id="projectLabel" maxlength="80" placeholder="z. B. Fantasy-Recherche" autocomplete="off" style="width:100%;padding:7px;border:1px solid #5c6c82;border-radius:7px;background:#263247;color:#fff"/>
        <label class="checkbox"><input id="loopGuard" type="checkbox"/> Auf ähnliche Antworten achten und bei dreifacher Wiederholung pausieren</label>
        <label for="checkpointEvery">Optionale Checkpoint-Pause (keine Extra-Nachricht)</label>
        <select id="checkpointEvery"><option value="0">Aus (Standard)</option><option value="5">Alle 5 beantworteten Nachrichten</option><option value="10">Alle 10 beantworteten Nachrichten</option><option value="20">Alle 20 beantworteten Nachrichten</option></select>
        <div class="scope-actions"><button id="toggleProjects" type="button" hidden>Archiv anzeigen</button><button id="restoreRun" type="button" disabled>Letzten sicheren Stand übernehmen</button><button id="discardRun" type="button">Lokalen CPQ-Stand zurücksetzen</button></div>
        <p id="recoveryInfo" class="scope-small">Kein gesicherter Lauf geladen.</p>
        <div id="projectList" class="scope-small" hidden></div>
        <p class="scope-small">Lokal werden nur Chat-Zuordnung, Name, Modus, Zähler und Versand-/Antwortstatus gespeichert. Keine Prompts oder Antworttexte. Wiederaufnahme erfordert neue Lauf-Freigabe. Statusmarker bleiben optional; CPQ ergänzt sie nicht von selbst.</p>
      </section>
      <div class="buttons"><button id="start" class="primary" type="button">Start</button><button id="approve" type="button">Nächsten freigeben</button><button id="pause" type="button">Pause</button><button id="stop" type="button">Stopp</button><button id="sendNow" type="button" title="Einmalige Fortsetzung nur innerhalb eines bestaetigten laufenden Autopiloten">Jetzt Weiter senden</button></div>
      <section class="status" aria-live="polite"><div id="state">Bereit</div><div id="detail">Nur im aktiven Chat.</div><div id="progress">0 / 0</div><div id="diagnostics">Diagnose: inaktiv</div><div class="buttons"><button id="copyDiagnostic" type="button">Diagnose kopieren (ohne Chattext)</button></div><div id="diagnosticNotice" class="note" aria-live="polite"></div><textarea id="diagnosticReport" readonly hidden spellcheck="false" aria-label="Anonymisierter Diagnosebericht zur manuellen Kopie" style="min-height:145px;font-size:11px;"></textarea></section>
      <p class="note">Opt-in-Automatik nur für diesen Chat: Bei unklarem Zustand, Limits, Wechsel des Chats oder fehlender Rückmeldung wird angehalten. Der Projektmodus liest nur das Statussignal der letzten Antwort, speichert keine Antworten. Kein API-Zugang und keine Limit-Umgehung.</p>
    </section>`;
  document.body.append(host);
  const $ = id => root.getElementById(id);
  const ui = {
    launch: $('launch'), panel: $('panel'), close: $('close'),
    preset: $('preset'), queue: $('queue'), mode: $('mode'),
    globalSwitch: $('globalSwitch'), chatSwitch: $('chatSwitch'), scopeText: $('scopeText'),
    stability: $('stability'), maxContinue: $('maxContinue'),
    maxProject: $('maxProject'), runStrategy: $('runStrategy'), durationHours: $('durationHours'), projectPrompt: $('projectPrompt'), projectClick: $('projectClick'), fallbackMissingMarker: $('fallbackMissingMarker'), fallbackContinueText: $('fallbackContinueText'),
    autoContinue: $('autoContinue'), start: $('start'), quickStart: $('quickStart'),
    approve: $('approve'), pause: $('pause'), stop: $('stop'), sendNow: $('sendNow'),
    state: $('state'), detail: $('detail'), progress: $('progress'), diagnostics: $('diagnostics'), copyDiagnostic: $('copyDiagnostic'), diagnosticNotice: $('diagnosticNotice'), diagnosticReport: $('diagnosticReport'),
    projectLabel: $('projectLabel'), loopGuard:$('loopGuard'), checkpointEvery:$('checkpointEvery'), toggleProjects:$('toggleProjects'), restoreRun:$('restoreRun'), discardRun:$('discardRun'), recoveryInfo:$('recoveryInfo'), projectList:$('projectList'),
    preflight: $('preflight'), preflightSummary: $('preflightSummary'), preflightText: $('preflightText'), confirmStart: $('confirmStart'), cancelStart: $('cancelStart')
  };
  ui.queue.value = initial.text;
  ui.mode.value = initial.mode;
  ui.stability.value = String(initial.waitSeconds);
  ui.maxContinue.value = String(initial.maxContinue);
  ui.autoContinue.checked = initial.autoContinue;
  ui.maxProject.value = String(initial.maxProject);
  ui.runStrategy.value = initial.runStrategy;
  ui.durationHours.value = String(initial.durationHours);
  ui.projectPrompt.value = initial.projectPrompt;
  ui.loopGuard.checked = initial.loopGuard;
  ui.checkpointEvery.value = String(initial.checkpointEvery);
  ui.projectClick.checked = initial.projectClick;
  ui.fallbackMissingMarker.checked = initial.fallbackMissingMarker;
  ui.fallbackContinueText.checked = initial.fallbackContinueText;

  // Projektfreigaben liegen separat von Prompts und werden NIE aus
  // Assistant-Ausgaben oder einer Notion-Datenbank übernommen.
  let scopeReady = false;
  let scope = { globalEnabled: false, allowedChats: {} };
  let lastScopeSerialized = ''; 
  function exactChatRoute() {
    if (!['chatgpt.com', 'chat.openai.com'].includes(location.hostname)) return '';
    const path = location.pathname.replace(/\/+$/, '');
    if (!/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]{8,}$/.test(path)) return '';
    return 'https://chatgpt.com' + path;
  }
  function approvedHere() {
    const key = exactChatRoute();
    return scopeReady && !!key && scope.globalEnabled && scope.allowedChats[key] === true;
  }
  function redrawScope() {
    const key = exactChatRoute();
    const registered = !!key && scope.allowedChats[key] === true;
    ui.scopeText.textContent = !scopeReady ? 'Lade lokale Freigaben …' : !key
      ? 'Kein gespeicherter Chat geöffnet. Neue Chats und Projektübersichten sind immer gesperrt.'
      : `${scope.globalEnabled ? 'Global EIN' : 'GLOBAL STOPP'} · ${registered ? 'Dieser Chat freigegeben' : 'Dieser Chat gesperrt'} · ${key}`;
    ui.globalSwitch.textContent = scope.globalEnabled ? 'GLOBAL STOPP' : 'Global einschalten';
    ui.globalSwitch.className = scope.globalEnabled ? 'danger' : '';
    ui.chatSwitch.textContent = registered ? 'Chat sperren' : 'Diesen Chat freigeben';
    ui.chatSwitch.disabled = !scopeReady || !key;
    ui.globalSwitch.disabled = !scopeReady;
    // Button-Zustand wird ausschließlich in render() berechnet. Ein nur
    // einseitiges Deaktivieren hier würde beim SPA-Chatwechsel bestehen bleiben.
  }
  function saveScope() {
    try {
      const v = JSON.stringify(scope);
      lastScopeSerialized = v;
      if (typeof chrome !== 'undefined' && chrome.storage?.local) chrome.storage.local.set({[SCOPE_KEY]: v});
      else if (typeof GM_setValue === 'function') GM_setValue(SCOPE_KEY, v);
      else localStorage.setItem(SCOPE_KEY, v);
    } catch (_) { scopeReady = false; }
  }
  function initScope(value) {
    scope = {globalEnabled:false, allowedChats:{}};
    lastScopeSerialized = typeof value === 'string' ? value : JSON.stringify(value || {});
    try {
      const x = typeof value === 'string' ? JSON.parse(value || '{}') : value;
      if (x && typeof x === 'object' && x.allowedChats && typeof x.allowedChats === 'object') {
        scope = {globalEnabled: x.globalEnabled === true, allowedChats: {}};
        for (const [k,v] of Object.entries(x.allowedChats)) {
          if (/^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]{8,}$/.test(k) && v === true) scope.allowedChats[k] = true;
        }
      }
    } catch (_) { scope = {globalEnabled:false, allowedChats:{}}; }
    scopeReady = true; redrawScope(); render(); updateRecoveryUI();
  }
  ui.globalSwitch.addEventListener('click', () => {
    if (!scopeReady) return;
    if (scope.globalEnabled) {
      scope.globalEnabled = false;
      if (running) endRun('Global gestoppt', 'Die globale Freigabe wurde entzogen.');
    } else {
      if (!confirm('CPQ-Automatik global einschalten? Nur einzeln freigegebene Chats können automatisch bearbeitet werden.')) return;
      scope.globalEnabled = true;
    }
    saveScope(); redrawScope(); render();
  });
  ui.chatSwitch.addEventListener('click', () => {
    const key = exactChatRoute();
    if (!key || !scopeReady) return;
    if (scope.allowedChats[key]) {
      delete scope.allowedChats[key];
      if (running) endRun('Chat gesperrt', 'Die Freigabe für diesen Chat wurde widerrufen.');
    } else {
      if (!confirm(`Nur diesen Chat für automatische CPQ-Läufe freigeben?\n${key}\nJeder Lauf braucht zusätzlich eine Startbestätigung.`)) return;
      scope.allowedChats[key] = true;
    }
    saveScope(); redrawScope(); render();
  });

  // Chrome-Erweiterung: Einstellungen liegen in chrome.storage.local
  // (Erweiterungs-Speicher statt dem mit der Website geteilten localStorage).
  // Bei Umstieg von v3 werden vorhandene lokale Einstellungen migriert.
  // Per-chat settings prevent chat A from overwriting chat B's quickstart
  // profile. Store them in extension local / Tampermonkey storage, never in
  // ChatGPT's own localStorage when either privileged API exists.
  const chatConfigKey = () => exactChatRoute() ? CHAT_CONFIG_PREFIX + exactChatRoute() : '';
  function applyChatSettings(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.text === 'string') ui.queue.value = data.text;
    if (['review','auto','continue-only','project','diagnose'].includes(data.mode)) ui.mode.value = data.mode;
    if ([8,12,20].includes(Number(data.waitSeconds))) ui.stability.value = String(data.waitSeconds);
    if ([1,2,3].includes(Number(data.maxContinue))) ui.maxContinue.value = String(data.maxContinue);
    if (typeof data.autoContinue === 'boolean') ui.autoContinue.checked = data.autoContinue;
    if ([1,3,5,10,15,20,30,50].includes(Number(data.maxProject))) ui.maxProject.value = String(data.maxProject);
    if (typeof data.projectPrompt === 'string') ui.projectPrompt.value = data.projectPrompt;
    if (typeof data.projectClick === 'boolean') ui.projectClick.checked = data.projectClick;
    if (typeof data.fallbackMissingMarker === 'boolean') ui.fallbackMissingMarker.checked = data.fallbackMissingMarker;
    if (typeof data.fallbackContinueText === 'boolean') ui.fallbackContinueText.checked = data.fallbackContinueText;
    if (typeof data.loopGuard === 'boolean') ui.loopGuard.checked = data.loopGuard;
    if ([0,5,10,20].includes(Number(data.checkpointEvery))) ui.checkpointEvery.value = String(data.checkpointEvery);
    if (['count','marker'].includes(data.runStrategy)) ui.runStrategy.value = data.runStrategy;
    if ([0,1,3,8].includes(Number(data.durationHours))) ui.durationHours.value = String(data.durationHours);
  }
  // ChatGPT navigiert häufig als SPA ohne Neuladen. Die zuletzt sichtbare
  // Auswahl darf dann weder Start blockieren noch in einen anderen Chat gelangen.
  let configRoute = null;
  let configLoadingRoute = null;
  let configGeneration = 0;
  let configLoading = false;
  function loadChatSettings(done=()=>{}, routeChanged=false) {
    const key = chatConfigKey();
    const route = exactChatRoute();
    const generation = ++configGeneration;
    configLoading = true;
    configLoadingRoute = route;
    const finish = data => {
      // Ein verspäteter Storage-Callback darf NIE fremde Chat-Settings laden.
      if (generation !== configGeneration || route !== exactChatRoute()) return;
      if (data && typeof data === 'object' && Object.keys(data).length) applyChatSettings(data);
      else if (routeChanged) applyChatSettings({text:'', ...safeSettings});
      configRoute = route;
      configLoadingRoute = null;
      configLoading = false;
      done();
      render();
      updateRecoveryUI();
    };
    if (!key) { finish(null); return; }
    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.get(key, values => finish(values?.[key]));
      } else if (typeof GM_getValue === 'function') {
        const raw=GM_getValue(key,'');
        finish(typeof raw === 'string' ? JSON.parse(raw || '{}') : raw);
      } else {
        finish(JSON.parse(localStorage.getItem(key) || '{}'));
      }
    } catch (_) { finish(null); }
  }
  function syncChatSettingsRoute() {
    const route = exactChatRoute();
    if (running || configRoute === route || (configLoading && configLoadingRoute === route)) return;
    loadChatSettings(()=>{}, configRoute !== null);
  }
  let storageReady = !(typeof chrome !== 'undefined' && chrome.storage?.local);
  if (!storageReady) {
    ui.start.disabled = true;
    chrome.storage.local.get(KEY, result => {
      const data = result?.[KEY];
      if (data && typeof data === 'object') {
        if (typeof data.text === 'string') ui.queue.value = data.text;
        if (['review','auto','continue-only','project','diagnose'].includes(data.mode)) ui.mode.value = data.mode;
        if ([8,12,20].includes(Number(data.waitSeconds))) ui.stability.value = String(data.waitSeconds);
        if ([1,2,3].includes(Number(data.maxContinue))) ui.maxContinue.value = String(data.maxContinue);
        if (typeof data.autoContinue === 'boolean') ui.autoContinue.checked = data.autoContinue;
        if ([1,3,5,10,15,20,30,50].includes(Number(data.maxProject))) ui.maxProject.value = String(data.maxProject);
        if (typeof data.projectPrompt === 'string') ui.projectPrompt.value = data.projectPrompt;
        if (typeof data.projectClick === 'boolean') ui.projectClick.checked = data.projectClick;
        if (typeof data.fallbackMissingMarker === 'boolean') ui.fallbackMissingMarker.checked = data.fallbackMissingMarker;
        if (typeof data.fallbackContinueText === 'boolean') ui.fallbackContinueText.checked = data.fallbackContinueText;
        if (typeof data.loopGuard === 'boolean') ui.loopGuard.checked = data.loopGuard;
        if ([0,5,10,20].includes(Number(data.checkpointEvery))) ui.checkpointEvery.value = String(data.checkpointEvery);
    if (['count','marker'].includes(data.runStrategy)) ui.runStrategy.value = data.runStrategy;
    if ([0,1,3,8].includes(Number(data.durationHours))) ui.durationHours.value = String(data.durationHours);
      } else {
        // Alte gespeicherte Werte werden beim Versionswechsel uebernommen.
        chrome.storage.local.set({ [KEY]: initial });
      }
      // Geteilten Website-Speicher bereinigen, ohne andere Eintraege anzuruehren.
      try { localStorage.removeItem(KEY); localStorage.removeItem('chatgpt-prompt-queue:v2'); } catch (_) { }
      loadChatSettings(() => {storageReady = true; render(); updateRecoveryUI();});
    });
  }


  function persist() {
    // Kein fremdes Chatprofil überschreiben, solange die SPA-Navigation lädt.
    if (configLoading || (configRoute !== null && configRoute !== exactChatRoute())) return;
    try {
      const settings = {
        text: ui.queue.value,
        mode: ui.mode.value,
        waitSeconds: Number(ui.stability.value),
        maxContinue: Number(ui.maxContinue.value),
        autoContinue: ui.autoContinue.checked,
        maxProject: Number(ui.maxProject.value),
        projectPrompt: ui.projectPrompt.value,
        projectClick: ui.projectClick.checked,
        fallbackMissingMarker: ui.fallbackMissingMarker.checked,
        fallbackContinueText: ui.fallbackContinueText.checked,
        loopGuard: ui.loopGuard.checked,
        checkpointEvery: Number(ui.checkpointEvery.value),
        runStrategy: ui.runStrategy.value,
        durationHours: Number(ui.durationHours.value)
      };
      const key=chatConfigKey();
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        chrome.storage.local.set(key ? { [KEY]: settings, [key]: settings } : { [KEY]: settings });
      } else if (typeof GM_setValue === 'function') {
        GM_setValue(KEY, JSON.stringify(settings));
        if (key) GM_setValue(key, JSON.stringify(settings));
      } else {
        localStorage.setItem(KEY, JSON.stringify(settings));
        if (key) localStorage.setItem(key, JSON.stringify(settings));
      }
    } catch (_) { /* Ohne Storage weiter */ }
  }
  if (storageReady) setTimeout(() => loadChatSettings(() => {render();updateRecoveryUI();}), 0);
  for (const el of [ui.queue, ui.mode, ui.stability, ui.maxContinue, ui.autoContinue, ui.maxProject, ui.projectPrompt, ui.projectClick, ui.fallbackMissingMarker, ui.fallbackContinueText, ui.loopGuard, ui.checkpointEvery, ui.runStrategy, ui.durationHours]) {
    el.addEventListener(el === ui.queue || el === ui.projectPrompt ? 'input' : 'change', persist);
  }
  ui.mode.addEventListener('change', () => {render();updateRecoveryUI();});
  for(const el of [ui.queue,ui.projectPrompt,ui.maxProject])el.addEventListener('input',()=>updateRecoveryUI());
  ui.preset.addEventListener('change', () => {
    if (ui.preset.value !== 'custom') { ui.queue.value = EXAMPLES[ui.preset.value]; persist(); }
  });
  ui.launch.addEventListener('click', () => {
    syncChatSettingsRoute();
    ui.panel.classList.add('open'); ui.launch.style.display = 'none';
    render();
  });
  ui.close.addEventListener('click', () => {
    ui.panel.classList.remove('open'); ui.launch.style.display = '';
  });

  function positionLauncher() {
    // ChatGPT frequently replaces its header. Use coordinates rather than
    // moving CPQ into React-owned markup; this avoids detached controls.
    const titleSelectors = [
      '[data-testid="conversation-title"]', '[data-testid="chat-title"]',
      '[data-testid="chat-header"] h1', 'main header h1',
      'header h1', 'header h2'
    ];
    let title = null;
    for (const selector of titleSelectors) {
      title = [...document.querySelectorAll(selector)].find(el =>
        el.isConnected && el.getClientRects().length && !el.closest('#cpq-v3-host'));
      if (title) break;
    }
    if (title) {
      const box = title.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(title);
      const textRect = range.getBoundingClientRect();
      const r = textRect.width > 0 ? textRect : box;
      const left = Math.round(r.right + 10);
      if (r.top >= 0 && r.top < 110 && left + 148 < innerWidth) {
        host.style.left = left + 'px';
        host.style.right = 'auto';
        host.style.top = Math.max(7, Math.round(r.top + (r.height - 31) / 2)) + 'px';
        return;
      }
    }
    host.style.left = 'auto';
    host.style.right = innerWidth < 700 ? '12px' : '100px';
    host.style.top = '12px';
  }
  window.addEventListener('resize', positionLauncher);
  positionLauncher();


  const isVisible = el => !!(el && el.isConnected && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const usable = el => isVisible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const caption = el => (el?.getAttribute('aria-label') || el?.innerText || el?.textContent || '').trim();
  const buttons = () => [...document.querySelectorAll('main button, [data-testid="composer"] button, form button')].filter(isVisible);
  // ChatGPT gestaltet die Nachrichtendarstellung um. Aktuelle Versionen
  // verwenden teils article[data-turn], statt data-message-author-role.
  // Nur sichtbare Konversation innerhalb main auswerten, keine Antwort speichern.
  function getConversationRoot() {
    // A ChatGPT layout can render the thread outside the first <main>.
    // Favor the element that actually contains conversation signals,
    // never a search field, sidebar, CPQ panel or unrelated overlay.
    const candidates = [
      document.querySelector('#thread'),
      document.querySelector('[data-testid="conversation-thread"]'),
      document.querySelector('[data-testid="conversation-panel"]'),
      document.querySelector('main'),
      document.querySelector('[role="main"]')
    ].filter(el => el && !el.closest('#cpq-v3-host, aside, nav, [role="dialog"]'));
    const signature = '[data-message-author-role], [data-turn="assistant"], [data-turn="user"], [data-testid^="conversation-turn"], [data-testid="assistant-message-content"], [data-testid="user-message-content"], .markdown, .prose';
    const count = el => el.querySelectorAll(signature).length;
    const withContent = candidates.filter(el => count(el));
    if (withContent.length) return withContent.sort((a,b) => count(b) - count(a))[0];
    const detached = [...document.querySelectorAll('[data-message-author-role], [data-testid^="conversation-turn"]')]
      .find(el => !el.closest('#cpq-v3-host, aside, nav, [role="dialog"], [role="menu"], form'));
    if (detached) return detached.closest('#thread, main, [role="main"], [data-testid="conversation-panel"]') || detached.parentElement;
    return candidates[0] || null;
  }
  function getTurns() {
    const main = getConversationRoot();
    if (!main) return [];
    const list = [];
    const seen = new Set();
    const shells = [...main.querySelectorAll(
      '[data-message-author-role], [data-turn="assistant"], [data-turn="user"], '
      + 'article[data-testid^="conversation-turn"], [data-testid^="conversation-turn-"], '
      + 'article[data-role], article[aria-label], article'
    )];
    // Sekundärer Fallback für eine Antwort ohne frühere Role-Attribute.
    // Die Markdown-Hülle allein gilt NICHT als sichere Zuordnung eines Users.
    for (const content of main.querySelectorAll('[data-testid="assistant-message-content"], [data-testid="message-content"], .markdown, .prose')) {
      const container = content.closest('article, [data-testid^="conversation-turn"], [data-turn], [data-message-author-role], [data-message-id]') || content;
      shells.push(container);
    }
    for (const el of shells) {
      const shell = el.closest('article[data-testid^="conversation-turn"], [data-testid^="conversation-turn-"], article[data-turn], article[data-message-author-role]') || el;
      if (seen.has(shell) || !shell.isConnected || shell.closest('form, aside, nav, [role="dialog"], [role="menu"]')) continue;
      seen.add(shell);
      const explicit = [shell, ...shell.querySelectorAll('[data-message-author-role], [data-turn], [data-role]')].find(n => {
        const v = (n.getAttribute('data-message-author-role') || n.getAttribute('data-turn') || n.getAttribute('data-role') || '').toLowerCase();
        return v === 'assistant' || v === 'user';
      });
      let role = explicit ? (explicit.getAttribute('data-message-author-role') || explicit.getAttribute('data-turn') || explicit.getAttribute('data-role')).toLowerCase() : '';
      let signal = explicit ? 'role' : '';
      if (!role) {
        const testid = (shell.getAttribute('data-testid') || '').toLowerCase();
        if (/(?:^|[-_])assistant(?:[-_]|$)/.test(testid)) {role = 'assistant'; signal = 'testid';}
        else if (/(?:^|[-_])user(?:[-_]|$)/.test(testid)) {role = 'user'; signal = 'testid';}
      }
      if (!role) {
        const feedback = shell.querySelector('[data-testid*="good-response"], [data-testid*="bad-response"], [data-testid*="thumbs-up"], [data-testid*="thumbs-down"], button[aria-label="Good response"], button[aria-label="Bad response"], button[aria-label="Gute Antwort"], button[aria-label="Schlechte Antwort"]');
        if (feedback) {role = 'assistant'; signal = 'feedback';}
        else if (shell.querySelector('[data-testid="assistant-message-content"]')) {role = 'assistant'; signal = 'assistant-content';}
        else if (shell.querySelector('.markdown, .prose') || shell.matches('.markdown, .prose')) {role = 'assistant'; signal = 'markdown';}
        else if (shell.querySelector('.whitespace-pre-wrap, [data-testid="user-message-content"]')) {role = 'user'; signal = 'user-content';}
      }
      if (role === 'assistant' || role === 'user') list.push({node:shell,role,signal});
    }
    // Typischerweise ein Wrapper je Turn. Falls ein Fallback-Element im
    // bereits erkannten Parent liegt, nur den Parent als Nachricht behandeln.
    return list.filter(x => !list.some(y => x !== y && y.node.contains(x.node))).sort((a,b) => {
      if (a.node === b.node) return 0;
      return a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
  }
  const assistantNodes = () => getTurns().filter(t => t.role === 'assistant').map(t => t.node);
  const userNodes = () => getTurns().filter(t => t.role === 'user').map(t => t.node);
  const lastAssistant = () => assistantNodes().at(-1) || null;
  function hasLatestAssistantReply() {
    const turns = getTurns();
    const last = turns.at(-1);
    if (!last || last.role !== 'assistant') return false;
    // Ohne einen sicher zugeordneten User-Turn nur dann fortfahren, wenn
    // die Antwort selber eindeutig erkannt ist oder explizit CPQ signalisiert.
    const hasUser = turns.some(t => t.role === 'user');
    const strong = ['role','testid','feedback','assistant-content'].includes(last.signal);
    return hasUser || strong || !!projectMarker();
  }

  // Prefer the actual conversation composer. Unscoped textareas such as
  // sidebar search boxes used to be misdetected as a "foreign draft".
  function getEditor() {
    const queries = [
      '#prompt-textarea',
      '[data-testid="composer-input"][contenteditable="true"]',
      'textarea[data-testid="composer-input"]',
      '[data-testid="composer"] [contenteditable="true"]',
      '[data-testid="composer"] textarea',
      'form div.ProseMirror[contenteditable="true"]',
      'form [contenteditable="true"][role="textbox"]',
      'form [contenteditable="true"]',
      'form textarea'
    ];
    for (const selector of queries) {
      const el = [...document.querySelectorAll(selector)].find(node =>
        isVisible(node) && !node.closest('aside,nav,[role="dialog"],[role="menu"]'));
      if (el) return el;
    }
    return null;
  }
  // ProseMirror can contain placeholder-only and zero-width text nodes.
  // Neither should count as a user draft. Do not erase real entered text.
  const normalizeEditorText = value => String(value || '')
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ').replace(/\r\n/g, '\n').trim();
  function editorText(el) {
    if (!el) return '';
    if (el.matches('textarea,input')) return normalizeEditorText(el.value);
    const placeholderSelector = '[data-placeholder], [data-testid*="placeholder"], [aria-hidden="true"], .ProseMirror-placeholder';
    if (!el.querySelector(placeholderSelector)) return normalizeEditorText(el.innerText || el.textContent);
    const copy = el.cloneNode(true);
    copy.querySelectorAll(placeholderSelector)
      .forEach(n => n.remove());
    return normalizeEditorText(copy.textContent);
  }
  const editorEmpty = el => !!el && !editorText(el);
  function editorDiagnostic() {
    const el=getEditor();
    return !el ? {state:'fehlt',kind:'none',chars:0}
      : {state:editorEmpty(el)?'leer':'belegt', kind:el.matches('textarea,input')?'textarea':'richtext', chars:editorText(el).length};
  }

  function sendButton(editor) {
    const targets = [
      'button[data-testid="send-button"]',
      'button[data-testid="composer-send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Nachricht senden"]',
      'button[aria-label="Senden"]',
      'button[aria-label="Send"]',
      'button[type="submit"]'
    ];
    const scope = editor?.closest('form') || editor?.closest('[data-testid="composer"]') || document;
    const candidates = [];
    for (const base of scope === document ? [document] : [scope, document]) {
      for (const selector of targets) {
        for (const button of base.querySelectorAll(selector)) {
          if (!isVisible(button) || candidates.includes(button)) continue;
          // Nur Sendebutton des Composers; andere Formulare und Chataktionen auslassen.
          if (scope !== document && !scope.contains(button)) continue;
          if (/stop|cancel|mic|voice|audio/i.test(`${button.getAttribute('data-testid') || ''} ${button.getAttribute('aria-label') || ''}`)) continue;
          candidates.push(button);
        }
      }
    }
    return candidates.find(usable) || candidates[0] || null;
  }

  function generating() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[data-testid="composer-stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop response"]',
      'button[aria-label="Antwort stoppen"]',
      'button[aria-label="Generierung stoppen"]'
    ];
    if (selectors.some(selector => [...document.querySelectorAll(selector)].some(isVisible))) return true;
    return buttons().some(el => /^(stop generating|stop response|antwort stoppen|generierung stoppen|stoppen)$/i.test(caption(el)));
  }

  // Only positive, visible RUNNING indicators inside the conversation count.
  // A completed/static tool card is never by itself an indication of activity.
  // We do not read or persist tool arguments, results, labels or chat text.
  function toolActivity() {
    const scope = getConversationRoot() || document.querySelector('main');
    if (!scope) return {active:false,source:'none'};
    const probes = [
      ['busy', '[data-testid*="tool" i][aria-busy="true"], [data-testid*="function" i][aria-busy="true"]'],
      ['busy-child', '[data-testid*="tool" i] [aria-busy="true"], [data-testid*="function" i] [aria-busy="true"]'],
      ['progress', '[data-testid*="tool" i] [role="progressbar"], [data-testid*="function" i] [role="progressbar"]'],
      ['running', '[data-testid*="tool" i][data-state="running"], [data-testid*="tool" i][data-status="running"], [data-testid*="function" i][data-state="running"]'],
      ['loading', '[data-testid*="tool" i][data-state="loading"], [data-testid*="tool" i] [data-state="loading"], [data-testid*="tool" i] .animate-spin'],
      ['working', '[data-testid*="tool" i] [data-status="running"], [data-testid*="tool" i] [aria-label="Running"]']
    ];
    for (const [source, selector] of probes) {
      for (const el of scope.querySelectorAll(selector)) {
        if (!isVisible(el) || el.closest('#cpq-v3-host, form, aside, nav, [role="dialog"], [role="menu"]')) continue;
        return {active:true,source};
      }
    }
    return {active:false,source:'none'};
  }

  function continueButton() {
    const last = lastAssistant();
    if (!last) return null;
    const generic = /^(weiter|continue)$/i;
    const explicit = /^(continue generating|continue response|continue generation|continue writing|fortsetzen|antwort fortsetzen|generierung fortsetzen|weiter generieren|weiterschreiben|weiter schreiben|antwort weiterführen)$/i;
    const candidates = buttons();
    for (const el of candidates) {
      if (!usable(el)) continue;
      if (el.closest('nav, aside, form, [role="dialog"], [role="menu"]')) continue;
      const label = caption(el);
      if (last.contains(el)) continue; // Assistant-Auswahlbuttons sind keine nativen Generierungs-Controls.
      if (explicit.test(label)) return el;
      if (!generic.test(label)) continue;
      // „Weiter“ allein ist mehrdeutig. Nur eindeutige native IDs zulassen.
      const marker = `${el.getAttribute('data-testid') || ''} ${el.getAttribute('aria-label') || ''}`;
      if (/continue[-_ ]?(generat|response|answer)|resume[-_ ]?generat/i.test(marker)) return el;
    }
    return null;
  }

  // Statt semantischer Textanalyse wird ausschliesslich ein expliziter
  // Abschlussmarker am ENDE des letzten Assistant-Turns ausgewertet.
  // Andere Teile der Antwort werden weder protokolliert noch gespeichert.
  function projectMarker() {
    const turn = lastAssistant();
    if (!turn) return '';
    // ChatGPT kann nach dem eigentlichen Antworttext Copy/Feedback-Buttons
    // rendern. Diese duerfen das letzte Textsignal nicht verdecken.
    const contentCandidates = [...turn.querySelectorAll(
      '[data-testid="assistant-message-content"], [data-testid="message-content"], .markdown, .prose'
    )].filter(isVisible);
    const content = contentCandidates.length ? contentCandidates[0] : turn;
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let lastText = '';
    let node;
    while ((node = walker.nextNode())) {
      const value = (node.nodeValue || '').trim();
      if (!value) continue;
      let parent = node.parentElement;
      let skip = false;
      while (parent && parent !== content) {
        if (parent.matches('pre, code, blockquote, button, a, nav, aside, [role="button"], [role="note"], [aria-hidden="true"], [hidden]') || !isVisible(parent)) {
          skip = true; break;
        }
        parent = parent.parentElement;
      }
      if (!skip && isVisible(node.parentElement)) lastText = (node.nodeValue || '').trim();
    }
    const match = lastText.match(/(?:^|\n)\s*\[\[CPQ:(WEITER|FERTIG|PRUEFEN)\]\]\s*$/i);
    return match ? match[1].toUpperCase() : '';
  }
  function projectChoiceButton() {
    const turn = lastAssistant();
    if (!turn || projectMarker() !== 'WEITER') return null;
    return [...turn.querySelectorAll('button')].find(el =>
      usable(el) && /^\s*(?:▶\s*)?Weiter\s*[·\-]\s*CPQ\s*$/i.test(caption(el))
    ) || null;
  }

  function alertMessage() {
    const error = /(?:rate limit|usage limit|you(?:'ve| have) reached|too many requests|try again later|something went wrong|network error|limit erreicht|nutzungslimit|versuche es später|ein fehler ist aufgetreten|captcha|verify you are human|überlastet|temporarily unavailable)/i;
    const targets = document.querySelectorAll('[role="alert"], [data-sonner-toast], [data-testid="error-message"], [data-testid="error-toast"]');
    for (const el of targets) {
      if (!isVisible(el)) continue;
      const txt = (el.innerText || el.textContent || '').slice(0, 400);
      if (error.test(txt)) return txt.slice(0, 110).replace(/\s+/g, ' ');
    }
    return '';
  }

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const samePrompt = (a,b) => (a || '').replace(/\r\n/g,'\n').trim() === (b || '').replace(/\r\n/g,'\n').trim();
  // Native Eingabe statt reines el.textContent: bei ProseMirror sieht sonst
  // der Text korrekt aus, wird aber nicht in den Editor-State übernommen.
  async function putText(el, content) {
    if (!el?.isConnected || !editorEmpty(el)) return false;
    el.focus();
    if (el.matches('textarea,input')) {
      const proto = el.matches('textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, content); else el.value = content;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      if (!el.isContentEditable) return false;
      // Browser-Editing statt direkte textContent-Manipulation. ProseMirror
      // überträgt DOM/Input-Events zum Teil erst nach mehreren Render-Ticks.
      const selectEnd = () => {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el); range.collapse(false);
        selection.removeAllRanges(); selection.addRange(range);
      };
      selectEnd();
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, content); } catch (_) { /* Browser API */ }
      if (!inserted) {
        // Erst sicherstellen, dass auch nicht verzögert etwas eingefügt wurde.
        await sleep(260);
        if (!el.isConnected || getEditor() !== el) return false;
        if (editorEmpty(el)) {
          // Nur einmaliger, HTML-escaped Browser-Editing-Fallback; KEIN
          // Direktsetzen von textContent und niemals bei fremdem Entwurf.
          selectEnd();
          const safe = content.replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\n/g,'<br>');
          try { document.execCommand('insertHTML', false, safe); } catch (_) { /* Browser API */ }
        }
      }
    }
    // Der Editor darf asynchron akzeptieren, muss aber den EXAKTEN Text
    // zeigen. Kein zweiter insertText-Versuch bei ungeklärtem Zwischenstand.
    const end = Date.now() + 2500;
    while (Date.now() <= end) {
      if (!el.isConnected || getEditor() !== el || !running || !allowedEditorText(el, content)) return false;
      if (samePrompt(editorText(el), content)) return true;
      await sleep(100);
    }
    return false;
  }
  function allowedEditorText(el, content) {
    const actual = editorText(el);
    // Reaktives Eingabefeld darf anfangs leer oder ein echtes Präfix sein.
    // Jede abweichende Eingabe wird geschützt und nie überschrieben.
    return !actual || samePrompt(actual, content) || content.startsWith(actual);
  }
  // Bereits vorhandener exakt gleicher Fortsetzungsprompt darf NUR nach
  // erneuter expliziter Startfreigabe übernommen werden. Fremde Entwürfe nie.
  const nextPrompt = () => ['project','continue-only'].includes(mode) ? ui.projectPrompt.value.trim() : queue[completed];
  const approvedDraft = () => {
    const editor = getEditor();
    const expected = nextPrompt();
    return !!(editor && expected && samePrompt(editorText(editor), expected));
  };

  let queue = [];
  let completed = 0;
  let running = false;
  let paused = false;
  let phase = 'idle';
  let mode = 'review';
  let pathAtStart = '';
  let lastSentAt = 0;
  let nextSendAt = 0;
  let current = null;
  let message = 'Bereit';
  let explanation = 'Prompts eintragen, Modus wählen und starten.';
  let liveObserver = null;
  let manualContinue = null;
  let projectCount = 0;
  let batchBaseCount = 0;
  let runDeadlineAt = 0;
  const strategyIsMarker = () => ['project','continue-only'].includes(mode) && ui.runStrategy.value === 'marker';
  const approvedBatchCount = () => strategyIsMarker() ? projectCount-batchBaseCount : projectCount;
  const runTimedOut = () => runDeadlineAt > 0 && Date.now() >= runDeadlineAt;
  const durationDescription = () => Number(ui.durationHours.value) ? `${ui.durationHours.value} Std.` : 'ohne Zeitgrenze';
  let projectInitialActivityAt = 0;
  let sendingInProgress = false;
  let sendStage = '–';
  let lastAckSignal = 'noch kein Sendeklick';
  let editorClearedOnlyObserved = false; // niemals als bestätigten Versand zaehlen
  let ackBackgroundPending = false; // nur transient, keine Wiederholungsfreigabe
  let ackBackgroundDeferrals = 0;
  let lastForegroundEpoch = 0;
  let windowAway = false; // Wechsel in ein anderes Browser-/Programmfenster
  // Timers koennen im Hintergrund gedrosselt, beim Einfrieren komplett
  // angehalten werden. Weder Timeout noch Leerlauf sind ein Beweis fuer
  // einen erfolgreichen Versand. Die originalen Limits bleiben aktiv.
  let lastHeartbeatAt = Date.now();
  let lastSchedulerGapMs = 0;
  let wakeGraceUntil = 0;
  let frozenDuringRun = false;
  let domWakeups = 0;
  let wakeupScheduled = false;
  let lastBadgeSignature = '';
  let lastBadgeAt = 0;
  let lifecycleState = document.visibilityState === 'hidden' ? 'hintergrund' : 'sichtbar';
  // Passive Metadaten: gleiche Web-Origin, lokale Speicherung. Keine Chat-/Prompttexte.
  // Der Name ist nutzerdefiniert. Keine Logdaten in externen Diensten.
  let runKnown = false;
  let storedRunRoute = '';
  let outstandingDelivery = false; // von erstem Klick bis definitiv abgeschlossener Antwort
  let safeCounts = null;
  let resumeRequest = null;
  let restoredFromLedger = false;
  let consecutiveSimilar = 0;
  let priorReplyGrams = null; // nur im RAM, keine Rohtexte persistieren
  function ledgerKey(route=exactChatRoute()) { return route ? LEDGER_PREFIX + encodeURIComponent(route) : ''; }
  function readLedger(route=exactChatRoute()) {
    try { const raw=localStorage.getItem(ledgerKey(route)); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  // Persistenter At-most-once-Schutz: Ein ungeklaerter Sendeklick bleibt
  // auch bei NEUEM Start blockiert, nicht nur bei 'Stand uebernehmen'.
  // Kein stillschweigender Reset der ausstehenden Versandmarkierung.
  function unresolvedPreviousDelivery() {
    const saved = readLedger();
    return !!(saved && saved.v === 1 && saved.pending === true && saved.route === exactChatRoute());
  }
  function guardUnresolvedPreviousDelivery() {
    if (!unresolvedPreviousDelivery()) return false;
    abortBeforeRun('Vorheriger Versand ungeklärt',
      'CPQ hat im selben Chat einen nicht bestätigten Sendeklick gespeichert. Prüfe zuerst den letzten Chat-Verlauf. Danach unter Projektübersicht „Stand dieses Chats löschen“ bewusst zurücksetzen. Kein automatischer Zweitversuch.');
    return true;
  }
  function tinyHash(value) { // nur zum Vergleichen der unveraenderten Einstellungen
    let h=2166136261;
    for (const c of value) { h ^= c.charCodeAt(0); h = Math.imul(h,16777619); }
    return (h>>>0).toString(16);
  }
  // Ein reiner Nachrichtenzähler kann durch Regeneration/Ersetzung denselben
  // Wert behalten. Die letzten acht gerenderten Turns werden deshalb anhand
  // STABILER technischer Nachrichtenkennungen identifiziert. Keine Text-Hashes:
  // Prompts/Antworten bleiben unverändert und gehen nicht in die Persistenz.
  // Variante 3.2.2: UUID-basierte Test-/DOM-IDs sind ebenfalls erlaubt.
  // Index-basierte Test-IDs (conversation-turn-12) gelten ausdrücklich nicht.
  const STABLE_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const UUID_TURN_ID = new RegExp('^(?:conversation-turn|chat-message|message)[-_](' + STABLE_UUID + ')$', 'i');
  function identifyTurn(turn) {
    const element = turn.node;
    // Den alten Mechanismus priorisieren, damit vorhandene v3.2.1-Fingerprints
    // mit unveraenderten Nachrichten-IDs weiterhin gueltig bleiben.
    for (const el of [element, ...element.querySelectorAll('[data-message-id], [data-turn-id]')]) {
      for (const attr of ['data-message-id','data-turn-id']) {
        const value = el.getAttribute(attr) || '';
        if (/^[\w-]{8,}$/.test(value)) return {id:value,source:attr};
      }
    }
    // Einige Chat-Layouts tragen UUIDs nur im data-testid oder DOM-id.
    // Ausschliesslich bekannte Nachrichten-Huellen akzeptieren. Positions-
    // indizes und beliebige UUIDs auf Buttons/Anhaengen werden ignoriert.
    for (const el of [element, ...element.querySelectorAll('[data-testid], [id]')]) {
      if (el.closest('button, nav, aside, [role="dialog"], [role="menu"]')) continue;
      for (const attr of ['data-testid','id']) {
        const value = el.getAttribute(attr) || '';
        const matched = UUID_TURN_ID.exec(value);
        if (matched) return {id:matched[1].toLowerCase(),source:attr === 'id' ? 'dom-id' : 'testid-uuid'};
      }
    }
    return null;
  }
  function inspectConversationIdentity() {
    const turns = getTurns();
    const tail = turns.slice(-Math.min(turns.length, 8));
    const details = {status:'ok',inspected:tail.length,identified:0,sources:{messageId:0,turnId:0,testidUuid:0,domIdUuid:0},fingerprint:''};
    if (turns.length < 2) details.status='zu_wenige_nachrichten';
    else if (turns.at(-1)?.role !== 'assistant') details.status='letzter_turn_kein_assistant';
    const ids = new Set(), parts=[];
    for (const turn of tail) {
      const identity = identifyTurn(turn);
      if (!identity) { details.status = 'kennung_fehlt'; continue; }
      details.identified++;
      const sourceKey = {'data-message-id':'messageId','data-turn-id':'turnId','testid-uuid':'testidUuid','dom-id':'domIdUuid'}[identity.source];
      if (sourceKey) details.sources[sourceKey]++;
      if (ids.has(identity.id)) details.status='kennung_mehrfach';
      ids.add(identity.id);
      parts.push(turn.role+':'+identity.id);
    }
    if (details.status === 'ok' && details.identified === tail.length) {
      details.fingerprint=tinyHash(String(turns.length)+'|'+parts.join('|'));
    }
    return details;
  }
  const conversationIdentity = () => inspectConversationIdentity().fingerprint;
  function configHash() {
    const prompts = ['project','continue-only'].includes(mode) ? ui.projectPrompt.value.trim() : queue.join('\n===\n');
    return tinyHash(mode + '\n' + prompts);
  }
  // Kritischer Schutz: vor einem automatischen Sendeklick muss das lokale
  // At-most-once-Protokoll nicht nur geschrieben, sondern auch unmittelbar
  // mit identischen Bytes zurueckgelesen worden sein. Browser-Speicher kann
  // deaktiviert, voll oder stillschweigend unwirksam sein.
  function saveRunRecord({verify=false} = {}) {
    if (!runKnown || !storedRunRoute) return false;
    const route=storedRunRoute, old=readLedger(route);
    const record={v:1,route, name:ui.projectLabel.value.trim().slice(0,80) || old?.name || '',
      mode, completed,projectCount,maxProject:Number(ui.maxProject.value),
      runStrategy:ui.runStrategy.value, durationHours:Number(ui.durationHours.value), batchBaseCount,
      status: running ? (paused ? 'paused' : 'running') : phase==='halted' ? 'halted' : 'stopped',
      phase, pending:outstandingDelivery || !!current || sendingInProgress,
      safeCounts, config:configHash(),
      maxQueue:queue.length, lastState:message.slice(0,100), updated:Date.now()};
    let saved=false;
    try {
      const key=ledgerKey(route);
      const value=JSON.stringify(record);
      localStorage.setItem(key,value);
      saved=!verify || localStorage.getItem(key)===value;
    } catch (_) { saved=false; }
    updateRecoveryUI();
    return saved;
  }
  function ledgerEntries() {
    const items=[];
    try {
      for(let i=0;i<localStorage.length;i++) {
        const k=localStorage.key(i);
        if (!k?.startsWith(LEDGER_PREFIX)) continue;
        const value=JSON.parse(localStorage.getItem(k));
        if (value?.v===1 && /^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\/[\w-]{8,}$/.test(value.route)) items.push(value);
      }
    } catch (_) { /* localStorage nicht verfügbar */ }
    return items.sort((a,b)=>(b.updated||0)-(a.updated||0)).slice(0,LEDGER_MAX);
  }
  function recoveryEligible(r) {
    if (!r || r.pending || !r.safeCounts || r.safeCounts.completed < 1) return false;
    const presentIdentity = conversationIdentity();
    if (!r.safeCounts.historyIdentity || !presentIdentity || r.safeCounts.historyIdentity !== presentIdentity) return false;
    if (['Fertig','Aufgabe abgeschlossen','Projektphase abgeschlossen','Prüfung erforderlich','Deine Freigabe benötigt'].includes(r.lastState)) return false;
    if (['project','continue-only'].includes(r.mode) && ['FERTIG','PRUEFEN'].includes(projectMarker())) return false;
    if (running || generating() || continueButton()) return false;
    if (!getEditor() || !editorEmpty(getEditor()) || !hasLatestAssistantReply()) return false;
    if (r.safeCounts.userTurns !== userNodes().length || r.safeCounts.assistantTurns !== assistantNodes().length) return false;
    if (r.mode !== ui.mode.value) return false;
    if ((r.runStrategy || 'count') !== ui.runStrategy.value) return false;
    const raw=ui.queue.value.split(/^\s*===\s*$/m).map(x=>x.trim()).filter(Boolean);
    const h=tinyHash(ui.mode.value+'\n'+(['project','continue-only'].includes(r.mode) ? ui.projectPrompt.value.trim() : raw.join('\n===\n')));
    if (r.config !== h) return false;
    if (!['project','continue-only'].includes(r.mode) && r.safeCounts.completed >= raw.length) return false;
    if (['project','continue-only'].includes(r.mode) && r.safeCounts.projectCount >= Number(ui.maxProject.value) &&
        !(r.runStrategy === 'marker' && ['Batch-Limit erreicht','Wiederaufnahme vorbereitet','Freigabe erforderlich'].includes(r.lastState))) return false;
    return true;
  }
  function updateRecoveryUI() {
    const r=readLedger();
    if (!r) { ui.recoveryInfo.textContent='Für diesen Chat ist noch kein Laufstand gespeichert.';ui.restoreRun.disabled=true;return; }
    const safe=r.safeCounts;
    const identity = inspectConversationIdentity();
    ui.recoveryInfo.textContent=`Letzter Stand: ${r.completed} Antworten / ${r.projectCount} Fortsetzungen · ${r.status} · ${r.pending ? 'Letzter Versand UNGEKLÄRT: Neue Automatikläufe gesperrt. Chat prüfen; danach „Stand dieses Chats löschen“ wählen.' : !safe ? 'Noch kein abgeschlossener Checkpoint' : !safe.historyIdentity ? 'Stabile Nachrichtenkennungen fehlen; Wiederaufnahme gesperrt' : !identity.fingerprint ? `Stabile Nachrichtenkennungen fehlen auf dieser Seite (${identity.identified}/${identity.inspected}; ${identity.status}); Wiederaufnahme gesperrt` : safe.historyIdentity !== identity.fingerprint ? 'Nachrichtenidentität hat sich verändert; Wiederaufnahme gesperrt' : 'Identität des Antwort-Checkpoints geprüft'}.`;
    ui.restoreRun.disabled=!recoveryEligible(r) || !approvedHere();
  }
  function renderProjects() {
    ui.projectList.replaceChildren();
    for(const r of ledgerEntries()) {
      const item=document.createElement('div');
      item.style.cssText='padding:7px 0;border-top:1px solid #43536c;';
      const short=r.route.split('/').at(-1).slice(-8);
      const title=document.createElement('strong'); title.textContent=r.name || 'Chat …'+short;
      const info=document.createElement('div');info.textContent=`${r.mode}: ${r.completed} Antworten, ${r.projectCount} Weiter · ${r.pending?'Versand unklar':r.status}`;
      item.append(title, info);ui.projectList.append(item);
    }
    if (!ui.projectList.childNodes.length) ui.projectList.textContent='Noch keine lokalen Projekte.';
  }
  ui.toggleProjects.addEventListener('click',()=>{
    ui.projectList.hidden=!ui.projectList.hidden;
    ui.toggleProjects.textContent=ui.projectList.hidden?'Projektübersicht anzeigen':'Projektübersicht schließen';
    if(!ui.projectList.hidden) renderProjects();
  });
  ui.projectLabel.addEventListener('input',()=>{
    const r=readLedger();
    if (r) { r.name=ui.projectLabel.value.trim().slice(0,80); r.updated=Date.now(); try{localStorage.setItem(ledgerKey(),JSON.stringify(r));}catch(_){} }
    if(!ui.projectList.hidden)renderProjects();
  });
  ui.discardRun.addEventListener('click',()=>{
    if(running)return;
    const unconfirmed = unresolvedPreviousDelivery();
    const warning = unconfirmed
      ? 'ACHTUNG: Der vorige Versand ist UNGEKLÄRT. Prüfe im Chat zuerst, ob die Nachricht bereits gesendet wurde!\n\nDas Zurücksetzen löscht nur die lokale CPQ-Markierung und kann bei anschließendem Neustart zu einer doppelten „Weiter“-Nachricht führen.\n\nLaufstand dieses Chats wirklich zurücksetzen?'
      : 'Gespeicherten Laufstand nur dieses Chats löschen? Kein Chatinhalt wird gelöscht.';
    if(!confirm(warning))return;
    try{localStorage.removeItem(ledgerKey());}catch(_){}
    resumeRequest=null;runKnown=false;safeCounts=null;outstandingDelivery=false;
    updateRecoveryUI(); if(!ui.projectList.hidden)renderProjects();
  });
  ui.restoreRun.addEventListener('click',()=>{
    const r=readLedger();
    if(!recoveryEligible(r)||!approvedHere()) {updateRecoveryUI();return;}
    resumeRequest={...r.safeCounts, mode:r.mode, config:r.config, runStrategy:r.runStrategy || 'count'};
    // Nie ohne normale Startbestaetigung und Web-Lock weitersenden.
    logStatus('Wiederaufnahme vorbereitet','Letzter sicher abgeschlossener Antwortschritt ausgewählt. Start klicken und den Lauf erneut freigeben.');
  });
  const gramsForLastAnswer=()=>{
    const turn=lastAssistant();if(!turn)return null;
    const el=turn.querySelector('[data-testid="assistant-message-content"], .markdown, .prose') || turn;
    const normalized=(el.innerText || el.textContent || '').replace(/\[\[CPQ:(?:WEITER|FERTIG|PRUEFEN)\]\]/gi,'')
      .toLocaleLowerCase().replace(/\s+/g,' ').trim().slice(0,10000);
    if(normalized.length<180)return null; // Bei kurzen Antworten zu viele false positives
    const set=new Set();for(let i=0;i<normalized.length-5;i+=2)set.add(normalized.slice(i,i+6));
    return set;
  };
  function inspectRepetition() {
    if(!ui.loopGuard.checked){priorReplyGrams=null;consecutiveSimilar=0;return false;}
    const curr=gramsForLastAnswer();
    if(!curr) { priorReplyGrams=null;consecutiveSimilar=0;return false; }
    if(priorReplyGrams) {
      let same=0;for(const v of curr)if(priorReplyGrams.has(v))same++;
      const similarity=same/(priorReplyGrams.size+curr.size-same);
      consecutiveSimilar=similarity>=0.90 ? consecutiveSimilar+1:0;
    }
    priorReplyGrams=curr;
    if(consecutiveSimilar>=2) {
      haltedForLoop=true;
      halt('Mögliche Wiederholung erkannt', 'Drei sehr ähnliche Antworten hintereinander. Vor einer weiteren Fortsetzung bitte prüfen. Keine Prompttexte gespeichert.');
      return true;
    }
    return false;
  }
  let haltedForLoop=false;
  function pauseAtCheckpoint() {
    const every=Number(ui.checkpointEvery.value);
    if(!running || !every || completed<1 || completed%every!==0)return;
    paused=true;
    logStatus('Checkpoint-Pause', `${completed} Antworten abgeschlossen. Projektstand bitte selbst prüfen; keine zusätzliche Nachricht gesendet. Mit „Fortsetzen“ weiterarbeiten.`);
  }
  // Vor Nachlade-Freigabe sichtbar machen: nie automatisch fortsetzen.
  // SPA-Turns koennen nach dem Panel geladen werden; Recovery wird dann neu validiert.
  setInterval(()=>{if(!running)updateRecoveryUI();},1500);
  setTimeout(()=>{
    const r=readLedger();if(r?.name)ui.projectLabel.value=r.name;
    if(r?.status==='running') ui.recoveryInfo.textContent='Ein früherer Lauf wurde unterbrochen. Neustart erfolgt nicht automatisch.';
    updateRecoveryUI();
  },50);
  function delayOutgoingAfterResume(reason) {
    if (!running) return;
    wakeGraceUntil = Math.max(wakeGraceUntil, Date.now() + RESUME_CHECK_MS);
    traceEvent(reason);
  }
  // Badge ist rein lokal und enthaelt weder Chat-URLs noch Inhalte.
  function badgeStatus() {
    if (!running) return phase === 'halted' ? {status:'halt',label:'!'} : message === 'Fertig' || message === 'Aufgabe abgeschlossen' || message === 'Projektphase abgeschlossen' ? {status:'done',label:'OK'} : {status:'idle',label:''};
    if (paused) return {status:'pause',label:'II'};
    const done = ['project','continue-only'].includes(mode) ? approvedBatchCount() : completed;
    const total = mode === 'project' || mode === 'continue-only' ? Number(ui.maxProject.value) : queue.length;
    return {status:'run',label:total ? `${done}/${total}` : 'RUN'};
  }
  function reportBadge() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id || !chrome.runtime.sendMessage) return;
    const {status,label} = badgeStatus();
    const background = document.visibilityState === 'hidden';
    const signature = `${status}|${label}|${background}`;
    if (signature === lastBadgeSignature && Date.now() - lastBadgeAt < 30000) return;
    lastBadgeSignature = signature;
    lastBadgeAt = Date.now();
    try {
      chrome.runtime.sendMessage({kind:'cpq-status-v320',status,label,background}, () => {void chrome.runtime.lastError;});
    } catch (_) { /* Userscript ohne Extension-Badge */ }
  }
  const auditTrail = []; // Maximal 16 Ereignisse im RAM, nie persistiert.
  function traceEvent(event) {
    if (typeof event !== 'string' || !/^[a-z0-9._:-]{1,60}$/i.test(event)) return;
    auditTrail.push({ts: new Date().toLocaleTimeString('de-DE', {hour12:false}),event});
    if (auditTrail.length > 16) auditTrail.shift();
  }
  function sanitizedReport() {
    const editor = getEditor(), sb = sendButton(editor);
    const isTextArea = editor?.matches('textarea,input');
    const editorType = !editor ? 'fehlt' : isTextArea ? 'textarea' : editor.isContentEditable ? 'contenteditable' : 'anderes';
    const t = getTurns();
    const idCheck = inspectConversationIdentity();
    const conversationRoot = getConversationRoot();
    const rootKind = !conversationRoot ? 'keine' : conversationRoot.id === 'thread' ? 'thread'
      : conversationRoot.tagName === 'MAIN' ? 'main'
      : conversationRoot.getAttribute('data-testid') === 'conversation-panel' ? 'conversation-panel'
      : conversationRoot.getAttribute('data-testid') === 'conversation-thread' ? 'conversation-thread'
      : 'andere';
    const turnCandidateCount = conversationRoot ? conversationRoot.querySelectorAll(
      '[data-message-author-role], [data-turn="assistant"], [data-turn="user"], [data-testid^="conversation-turn"], [data-testid="assistant-message-content"], [data-testid="user-message-content"], .markdown, .prose'
    ).length : 0;
    const data = {
      tool: 'CPQ Auto', version: VERSION, capturedAt: new Date().toISOString(),
      chatScope: exactChatRoute() ? 'Chat-Route erkannt (ID nicht enthalten)' : 'keine Chat-Route',
      approvedForThisChat: approvedHere(), globalScopeLoaded: scopeReady,
      run: {mode, running, paused, phase, completed, projectCount, batchCount:approvedBatchCount(), runStrategy:ui.runStrategy.value, durationHours:Number(ui.durationHours.value), deadlineReached:runTimedOut(), lastState: message},
      controls: {editorType, editorHasDraft: !!editor && !editorEmpty(editor), editorDetectedChars:editorDiagnostic().chars, composerFound:!!editor, sendButton: !sb ? 'fehlt' : usable(sb) ? 'bereit' : 'deaktiviert', generating: generating(), toolBusy: toolActivity().active, toolSignal: toolActivity().source, nativeContinue: !!continueButton(), webLocksAvailable: !!navigator.locks?.request, exclusiveLockHeld: !!exclusiveLockRelease},
      recognition: {assistantTurns: t.filter(x=>x.role==='assistant').length, userTurns: t.filter(x=>x.role==='user').length, lastSignal: t.at(-1)?.signal || 'keins', lastRole: t.at(-1)?.role || 'keine', rootKind, turnCandidateCount},
      identityCheck: {status:idCheck.status,inspected:idCheck.inspected,identified:idCheck.identified,sources:idCheck.sources,resumeFingerprintAvailable:!!idCheck.fingerprint},
      delivery: {sendStage, sendingInProgress, lastAckSignal, editorClearedOnlyObserved, awaitingAnswer: !!current, toolSeenInAnswer: !!current?.toolWasActive, toolWaitSeconds: current?.toolFirstSeenAt ? Math.round((Date.now()-current.toolFirstSeenAt)/1000) : 0, ackBackgroundPending, ackBackgroundDeferrals},
      background: {visibility:lifecycleState, windowUnfocused:windowAway, schedulerGapMs:lastSchedulerGapMs, wakeGraceActive:Date.now()<wakeGraceUntil, frozenDuringRun, domWakeups},
      projectManager:{metadataStored:!!readLedger(), previousDeliveryUnresolved:unresolvedPreviousDelivery(), repetitionHits:consecutiveSimilar, outstandingDelivery, safeAnswered:!!safeCounts, checkpointEvery:Number(ui.checkpointEvery.value)},
      events: auditTrail
    };
    return JSON.stringify(data, null, 2);
  }
  ui.copyDiagnostic.addEventListener('click', async () => {
    const report = sanitizedReport();
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(report); ui.diagnosticReport.hidden = true; ui.diagnosticNotice.textContent = 'Diagnose kopiert. Keine Chat-URLs, Prompt- oder Antworttexte enthalten.'; return; }
      throw new Error('Clipboard-API nicht verfügbar');
    } catch (_) {
      // Browser verhindern bisweilen Zugriff aufs Clipboard aus Content Scripts.
      // Text sichtbar darstellen, statt ungefragt Daten zu übertragen.
      ui.diagnosticReport.value = report;
      ui.diagnosticReport.hidden = false;
      ui.diagnosticReport.focus(); ui.diagnosticReport.select();
      ui.diagnosticNotice.textContent = 'Automatisches Kopieren nicht möglich. Die bereinigte Diagnose steht jetzt im Diagnosefeld zur manuellen Auswahl.';
    }
  });

  // Web Locks verhindern gleichzeitig laufende CPQ-Automatik in mehreren
  // Tabs desselben Chats. Eine Sperre gilt nur im selben Browserprofil/Origin.
  // Es gibt keine persistierte aktive Laufzeitfreigabe nach Reload.
  let exclusiveLockRelease = null;
  let exclusiveLockRoute = '';
  let exclusiveLockPending = false;
  function releaseExclusiveLock() {
    const release = exclusiveLockRelease;
    exclusiveLockRelease = null;
    exclusiveLockRoute = '';
    if (release) release();
  }
  function requestExclusiveLock(route) {
    if (exclusiveLockPending || exclusiveLockRelease) return;
    if (!navigator.locks || typeof navigator.locks.request !== 'function') {
      approvalGranted = false;
      logStatus('Automatik-Sperre nicht verfügbar', 'Browser unterstützt Web Locks hier nicht. Aus Sicherheitsgründen kein Automatiklauf.');
      return;
    }
    exclusiveLockPending = true;
    render();
    // ifAvailable wartet nicht auf andere Tabs: niemals stillschweigend später loslaufen.
    void navigator.locks.request('cpq:autopilot:' + route, {ifAvailable: true}, async lock => {
      exclusiveLockPending = false;
      if (!lock) {
        approvalGranted = false;
        render();
        logStatus('Chat bereits in anderem Tab aktiv', 'Nur ein automatischer CPQ-Lauf je Chat. Anderen Lauf stoppen, dann erneut starten und bestätigen.');
        return;
      }
      await new Promise(resolve => {
        exclusiveLockRelease = resolve;
        exclusiveLockRoute = route;
        if (!approvalGranted || !approvedHere() || route !== exactChatRoute() || awaitingRunApproval) {
          approvalGranted = false;
          releaseExclusiveLock();
          logStatus('Startfreigabe veraltet', 'Chat oder Freigabe hat sich während der Tab-Sperre verändert.');
          return;
        }
        render();
        ui.start.click();
      });
    }).catch(error => {
      exclusiveLockPending = false;
      approvalGranted = false;
      releaseExclusiveLock();
      logStatus('Tab-Sperre fehlgeschlagen', String(error?.message || error).slice(0, 150));
    });
  }
  function abortBeforeRun(title, detail) {
    phase = 'halted';
    approvalGranted = false;
    dismissPreflight();
    releaseExclusiveLock();
    logStatus(title, detail);
  }
  function logStatus(title, detail) { message = title; explanation = detail; traceEvent('status:' + ({'Sendeversuch läuft':'send_clicked','Prompt eingefügt':'editor_filled','Prompt vor Senden verändert':'editor_changed','Senden nicht bestätigt':'send_unconfirmed','Fortsetzungsnachricht 1 übergeben':'prompt_delivered'}[title] || 'update')); render(); reportBadge(); saveRunRecord(); }
  function endRun(title, detail) {
    releaseExclusiveLock();
    running = false; paused = false; current = null; manualContinue = null;
    phase = 'idle';
    logStatus(title, detail);
  }
  function halt(title, detail) {
    releaseExclusiveLock();
    running = false; paused = true;
    phase = 'halted';
    logStatus(title, detail);
  }
  function launcherState() {
    const ended = /(?:Fertig|abgeschlossen|Limit erreicht|Checkpoint erreicht|Prüfung erforderlich|Freigabe benötigt)/i.test(message);
    const record=!running ? readLedger() : null;
    const savedDone=!!record && /(?:Fertig|abgeschlossen|Limit erreicht|Checkpoint erreicht|Prüfung erforderlich|Freigabe benötigt)/i.test(record.lastState || '');
    const state=running ? (paused?'pause':'run') : ended || savedDone ? 'done' : (phase==='halted' || record?.pending || record?.status==='halted') ? 'halt' : 'idle';
    const count=running ? (['project','continue-only'].includes(mode) ? approvedBatchCount() : completed)
      : (record ? (['project','continue-only'].includes(record.mode) ? record.projectCount-(record.runStrategy==='marker' ? (record.batchBaseCount || 0) : 0) : record.completed) : 0);
    const total=running ? (['project','continue-only'].includes(mode) ? Number(ui.maxProject.value) : queue.length)
      : (record ? (['project','continue-only'].includes(record.mode) ? record.maxProject : record.maxQueue) : 0);
    return {state,label:total>0 ? `CPQ ${count}/${total}` : 'CPQ'};
  }
  function renderLauncher() {
    const {state,label}=launcherState();
    ui.launch.dataset.state=state;
    ui.launch.textContent=label;
    ui.launch.title=`CPQ ${state==='run'?'läuft':state==='done'?'beendet':state==='halt'?'Fehler':state==='pause'?'pausiert':'bereit'} – ${message}`;
  }
  function render() {
    renderLauncher();
    ui.state.textContent = message;
    ui.detail.textContent = explanation;
    ui.progress.textContent = mode === 'continue-only'
      ? `${approvedBatchCount()} / ${ui.maxProject.value} in diesem Paket · gesamt ${projectCount} Weiter-Nachrichten · native Klicks: ${manualContinue?.clicks || current?.continueClicks || 0}`
      : mode === 'project'
      ? `${completed} Antworten · ${approvedBatchCount()} / ${ui.maxProject.value} in diesem Paket (gesamt ${projectCount})${current ? ` · natives Weiter ${current.continueClicks}×` : ''}`
      : `${completed} / ${queue.length} Prompts abgeschlossen${current ? ` · Weiter-Klicks ${current.continueClicks}` : ''}`;
    ui.start.disabled = running || exclusiveLockPending || !storageReady || configLoading ||
      (configRoute !== null && configRoute !== exactChatRoute()) || (AUTOMATED.has(ui.mode.value) && !approvedHere());
    ui.quickStart.disabled = ui.start.disabled;
    redrawScope();
    for (const el of [ui.preset, ui.queue, ui.mode, ui.stability, ui.maxContinue, ui.autoContinue, ui.maxProject, ui.projectPrompt, ui.projectClick, ui.fallbackMissingMarker, ui.fallbackContinueText, ui.loopGuard, ui.checkpointEvery, ui.runStrategy, ui.durationHours, ui.projectLabel]) el.disabled = running;
    ui.approve.disabled = !running || mode !== 'review' || !paused || !!current || completed >= queue.length || phase !== 'ready';
    ui.pause.disabled = !running;
    ui.pause.textContent = paused ? 'Fortsetzen' : 'Pause';
    ui.stop.disabled = !running;
    ui.sendNow.disabled = !running || paused || !!current || !['project','continue-only'].includes(mode) || !approvedHere() || !exclusiveLockRelease;
  }
  function identityDisplay() {
    const result=inspectConversationIdentity();
    return `${result.identified}/${result.inspected} · ${result.status}`;
  }
  function monitorInfo() {
    return [
      `Freigabe: ${approvedHere() ? 'aktiv fuer diesen Chat' : 'gesperrt'} · ${exactChatRoute() || 'kein Chat'}`,
      `Tab-Sperre: ${exclusiveLockRelease ? 'gehalten' : exclusiveLockPending ? 'wird geprueft' : 'frei'}`,
      `Modus: ${mode}${running ? (paused ? ' · pausiert' : ' · aktiv') : ''}`,
      `Phase: ${phase}`,
      `Generierung: ${generating() ? 'ja' : 'nein'} · Eingabe: ${editorDiagnostic().state} (${editorDiagnostic().kind}, ${editorDiagnostic().chars} Zeichen) · Sendebutton: ${sendButton(getEditor()) ? (usable(sendButton(getEditor())) ? 'bereit' : 'DEAKTIVIERT') : 'fehlt'}`,
      `Senden: ${sendStage} · Sendelauf: ${sendingInProgress ? 'ja' : 'nein'} · Signal: ${lastAckSignal}`, 
      `Assistant-Turns: ${assistantNodes().length} · User-Turns: ${userNodes().length} · natives Weiter: ${continueButton() ? 'ja' : 'nein'}`,
      `Gesprächswurzel: ${getConversationRoot()?.id === 'thread' ? 'thread' : getConversationRoot()?.tagName?.toLowerCase() || 'nicht gefunden'}`,
      `Erkennung: ${getTurns().at(-1)?.signal || 'kein Konversationsblock'} · ${hasLatestAssistantReply() ? 'letzte Nachricht Assistant' : 'Antwort nicht bestätigt'}`, 
      `Projektmarker: ${projectMarker() || 'fehlt (optional)'} · CPQ-Button: ${projectChoiceButton() ? 'sichtbar' : 'nein'}`, 
      `Stabilitätsfenster: ${ui.stability.value}s · Maximale Weiter-Klicks: ${ui.maxContinue.value}`,
      `Lokaler Checkpoint: ${safeCounts?.completed || 0} Antworten · Wiederholungen: ${consecutiveSimilar} · Versand offen: ${outstandingDelivery ? 'ja':'nein'}`,
      `Fortsetzungsziel: ${ui.runStrategy.value==='marker' ? 'Marker/Pakete' : 'Nachrichtenlimit'} · Laufzeit: ${durationDescription()}${runDeadlineAt ? ` · Restzeit ${Math.max(0,Math.ceil((runDeadlineAt-Date.now())/60000))} min` : ''}`,
      `Nachrichten-IDs: ${identityDisplay()} (Details über Diagnose kopieren)`,
      `Tab: ${document.visibilityState === 'hidden' ? 'Hintergrund' : 'sichtbar'} · Zeitverzoegerung: ${Math.round(lastSchedulerGapMs/1000)}s · Ruhepruefung: ${Date.now()<wakeGraceUntil ? 'aktiv' : 'nein'}`
    ].join('\n');
  }
  function validatePath() {
    const path = location.pathname;
    return path === pathAtStart;
  }

  // DOM-Ereignisse helfen gerade in Hintergrund-Tabs, deren setInterval
  // unter Umstaenden nur noch selten ausgeloest wird. Kein Polling-Ersatz:
  // frozen/geschlossene Tabs koennen keine Skripte ausfuehren.
  function scheduleHeartbeatFromDOM() {
    if (!running || wakeupScheduled) return;
    wakeupScheduled = true;
    setTimeout(() => {
      wakeupScheduled = false;
      domWakeups++;
      heartbeat();
    }, 200);
  }
  // Nur Strukturänderungen am Assistant-Turn beobachten, keine Texte speichern.
  function observeConversation() {
    liveObserver?.disconnect();
    const container = document.querySelector('main') || document.body;
    liveObserver = new MutationObserver(records => {
      if (!current && !(running && mode === 'continue-only' && manualContinue) && !(running && mode === 'project' && phase === 'project-initial')) return;
      for (const record of records) {
        const target = record.target;
        const latest = lastAssistant();
        if (!latest) continue;
        const assistantChange = latest === target || latest.contains(target) ||
          [...record.addedNodes].some(node => node === latest || (node.nodeType === 1 && node.contains(latest)));
        if (assistantChange) {
          if (current) current.lastAssistantActivityAt = Date.now();
          if (manualContinue) manualContinue.lastActivityAt = Date.now();
          if (mode === 'project' && phase === 'project-initial') projectInitialActivityAt = Date.now();
          scheduleHeartbeatFromDOM();
          break;
        }
      }
    });
    liveObserver.observe(container, { subtree: true, childList: true, characterData: true });
  }

  function checkProjectMarker(now, isInitial) {
    const decision = hasLatestAssistantReply() ? projectMarker() : '';
    if (decision === 'FERTIG') { endRun('Projektphase abgeschlossen', 'ChatGPT hat [[CPQ:FERTIG]] ausgegeben. Keine weitere Nachricht.'); return; }
    if (decision === 'PRUEFEN') { halt('Deine Freigabe benötigt', 'ChatGPT hat [[CPQ:PRUEFEN]] ausgegeben. Kein automatisches Weiter.'); return; }
    if (decision !== 'WEITER' && !ui.fallbackMissingMarker.checked) { halt('Projektmarker fehlt', 'Kein CPQ-Marker; automatische Fortsetzung ohne Marker ist ausgeschaltet.'); return; }
    if (approvedBatchCount() >= Number(ui.maxProject.value)) {
      halt(strategyIsMarker() ? 'Batch-Limit erreicht' : 'Projekt-Limit erreicht', strategyIsMarker() ? `Paket mit ${ui.maxProject.value} Nachrichten beantwortet. Letzten sicheren Stand auswählen und nächstes Paket erneut bestätigen.` : `Maximal ${ui.maxProject.value} automatische Nachrichten pro Start. Bitte Ergebnis prüfen.`); return;
    }
    if (!ui.projectPrompt.value.trim()) { halt('Fortsetzungstext fehlt', 'Projekt-Nachricht darf nicht leer sein.'); return; }
    phase = 'ready';
    nextSendAt = now + (isInitial ? 500 : 1200);
    logStatus(decision === 'WEITER' ? 'CPQ-Weiter erkannt' : 'Automatisch ohne CPQ-Marker', `${decision === 'WEITER' ? 'CPQ-Fortsetzung' : 'Marker fehlt; explizit erlaubte Ersatzfortsetzung'}: Nachricht ${projectCount + 1} von ${ui.maxProject.value} folgt.`);
  }

  function finishStep(now) {
    current = null;
    completed++;
    outstandingDelivery = false; // Antwort vollstaendig / Ruhephase bestaetigt
    safeCounts = {completed, projectCount, userTurns:userNodes().length, assistantTurns:assistantNodes().length, historyIdentity:conversationIdentity()};
    if (inspectRepetition()) return;
    if (runTimedOut()) {halt('Zeitlimit erreicht','Die laufende Antwort ist abgeschlossen. Kein weiterer Prompt wird gesendet.');return;}

    if (mode === 'project') { checkProjectMarker(now, false); pauseAtCheckpoint(); return; }
    if (mode === 'continue-only') {
      if (hasLatestAssistantReply() && projectMarker() === 'FERTIG') { endRun('Aufgabe abgeschlossen', '[[CPQ:FERTIG]] empfangen.'); return; }
      if (hasLatestAssistantReply() && projectMarker() === 'PRUEFEN') { halt('Prüfung erforderlich', '[[CPQ:PRUEFEN]] empfangen.'); return; }
      phase = 'continue-only';
      manualContinue = {userCount:userNodes().length,clicks:0,seenAt:0,pending:false,clickedAt:0,lastActivityAt:now,firstObservedAt:now,allowWithoutTurn:true};
      logStatus('Fortsetzung beantwortet', `${projectCount} von ${ui.maxProject.value} Fortsetzungsnachrichten gesendet. Prüfe auf weitere Fortsetzung.`);
      pauseAtCheckpoint();
      return;
    }
    if (completed === queue.length) {
      endRun('Fertig', `Alle ${completed} Prompts wurden gesendet und eine Antwort wurde jeweils erkannt.`);
      return;
    }
    nextSendAt = Math.max(now + 1200, lastSentAt + MIN_SEND_GAP_MS);
    phase = 'ready';
    if (mode === 'review') {
      paused = true;
      logStatus(`Schritt ${completed} abgeschlossen`, 'Antwort prüfen; danach „Nächsten freigeben“ klicken.');
    } else {
      logStatus(`Schritt ${completed} abgeschlossen`, `Nächster Prompt automatisch, frühestens in ${Math.ceil((nextSendAt - now) / 1000)} s.`);
    }
    pauseAtCheckpoint();
  }

  async function sendNext() {
    if (sendingInProgress) return; // Keine zwei überlappenden Sendevorgänge.
    if (runTimedOut()) {halt('Zeitlimit erreicht','Zeitgrenze abgelaufen. Kein Sendeklick.');return;}
    // Eigene noch aktive Lieferung ist nie ein Anlass, sich selbst zu stoppen:
    // sendNext wird nur mit current===null und ohne laufenden Versand betreten.
    if (!outstandingDelivery && unresolvedPreviousDelivery()) {
      halt('Vorheriger Versand ungeklärt', 'Eine lokale ausstehende Nachricht wurde erkannt. Kein neuer Sendeklick. Chat prüfen und Stand bewusst zurücksetzen.');
      return;
    }
    if (AUTOMATED.has(mode) && !approvedHere()) { halt('Freigabe entzogen', 'Automatisches Senden wurde blockiert.'); return; }
    if (!running || paused || current || (!['project','continue-only'].includes(mode) && completed >= queue.length) || mode === 'diagnose') return;
    if (['project','continue-only'].includes(mode) && (approvedBatchCount() >= Number(ui.maxProject.value) || approvedBatchCount() >= MAX_AUTO_MESSAGES)) {halt(strategyIsMarker()?'Batch-Limit erreicht':'Fortsetzungslimit erreicht','Die pro Start bestätigte Nachrichtenanzahl wurde erreicht.'); return;}
    if (Date.now() < wakeGraceUntil) return; // nach Resume erst erneut den Chatstatus pruefen
    sendingInProgress = true;
    phase = 'sending';
    sendStage = 'Prüfung';
    ackBackgroundPending = false;
    const route = exactChatRoute();
    const allowed = () => running && !paused && validatePath() && route === exactChatRoute() &&
      (!AUTOMATED.has(mode) || (approvedHere() && !!exclusiveLockRelease && exclusiveLockRoute === route));
    try {
      if (!allowed()) { halt('Freigabe ungültig', 'Keine automatische Nachricht gesendet.'); return; }
      if (generating() || toolActivity().active || continueButton()) { halt('Noch eine Antwort aktiv', 'Generierung, Tool-Aufruf oder natives Weiter erkannt. Bitte selbst prüfen.'); return; }
      if (alertMessage()) { halt('Warnung erkannt', 'Mögliche Limit- oder Fehleranzeige. Bitte manuell prüfen.'); return; }
      const editor = getEditor();
      if (!editor) { halt('Eingabe nicht gefunden', 'Composer-Element nicht erkannt.'); return; }
      const prompt = nextPrompt();
      if (!prompt) { halt('Fortsetzungstext fehlt', 'Kein leerer Prompt wird versendet.'); return; }
      const projectButton = mode === 'project' && ui.projectClick.checked ? projectChoiceButton() : null;
      const beforeAssistant = assistantNodes().length;
      const beforeUser = userNodes().length;
      const adopting = !projectButton && approvedDraft();
      if (!projectButton && !adopting && !editorEmpty(editor)) {
        const check=getEditor();
        const info=editorDiagnostic();
        if (check !== editor && check && editorEmpty(check)) {
          traceEvent('composer_replaced_before_send');
          halt('Composer gewechselt', 'ChatGPT hat das Eingabefeld ersetzt. Nicht gesendet; bitte Start erneut bestätigen.'); return;
        }
        halt('Fremder Entwurf vorhanden', `CPQ erkennt im Chat-Composer ${info.chars} Zeichen (${info.kind}). Nicht überschrieben. Falls das Feld sichtbar leer ist, bitte die Diagnose kopieren.`); return;
      }
      if (!projectButton && !adopting) {
        sendStage = 'Einfügen';
        traceEvent('editor_insert_attempt');
        if (!await putText(editor, prompt)) {
          halt('Einfügen nicht übernommen', 'Editor hat das Einfügen nicht bestätigt. Keine unkontrollierte TextContent-Manipulation.'); return;
        }
      }
      sendStage = adopting ? 'Vorhandenen Prompt prüfen' : 'Editor wartet';
      traceEvent(adopting ? 'draft_adopted' : 'editor_inserted');
      logStatus(adopting ? 'Vorhandenen Prompt erkannt' : 'Prompt eingefügt', 'Warte darauf, dass der ChatGPT-Sendebutton aktiv wird.');
      // React/ProseMirror aktualisiert den Sendestatus manchmal asynchron.
      // Auf keinen Fall auf einen deaktivierten Button klicken.
      let button = projectButton;
      const readyBy = Date.now() + SEND_READY_WAIT_MS;
      while (!button || !usable(button)) {
        if (!allowed()) { halt('Senden abgebrochen', 'Chat, Freigabe oder Lauf geändert.'); return; }
        const activeEditor = getEditor();
        if (!projectButton && (!activeEditor || !samePrompt(editorText(activeEditor), prompt))) {
          halt('Entwurf verändert', 'Der vorbereitete Prompt ist nicht mehr unverändert vorhanden.'); return;
        }
        if (generating() || toolActivity().active || alertMessage()) { halt('ChatGPT beschäftigt', 'Kein Sendeklick während einer Generierung, Tool-Ausführung oder Fehlermeldung.'); return; }
        button = projectButton || sendButton(activeEditor);
        if (button && usable(button)) break;
        if (Date.now() > readyBy) {
          halt('Sendebutton bleibt deaktiviert', 'Der Text ist sichtbar, aber ChatGPT hat die Eingabe nicht als sendefähig bestätigt. Keine Nachricht gesendet.'); return;
        }
        await sleep(200);
      }
      if (!allowed()) { halt('Freigabe vor Senden verloren', 'Kein Sendeklick ausgeführt.'); return; }
      if (Date.now() < wakeGraceUntil) { halt('Aufwachen vor Sendeklick', 'Tab kehrte aus Unterbrechung zurueck. Bitte den vorbereiteten Prompt kontrollieren und erneut freigeben.'); return; }
      if (!projectButton && !samePrompt(editorText(getEditor()), prompt)) {
        halt('Prompt vor Senden verändert', 'Keine Nachricht gesendet.'); return;
      }
      if (!usable(button) || generating() || toolActivity().active) { halt('Senden nicht verfügbar', 'Button vor dem Klick nicht mehr bereit oder Tool-Aufruf läuft.'); return; }
      if (runTimedOut()) {sendingInProgress=false;halt('Zeitlimit erreicht','Zeitgrenze vor dem Sendeklick erreicht. Eingefügter Entwurf bleibt zur manuellen Prüfung erhalten.');return;}
      sendStage = 'Einmaliger Klick';
      traceEvent('send_button_ready');
      const sent = Date.now();
      outstandingDelivery = true;
      // Wenn der Browser die Schutzmarkierung nicht bestaetigt, KEIN Klick.
      // Eine moeglicherweise geschriebene, aber nicht lesbare pending-Markierung
      // bleibt im Zweifel erhalten (fail-closed).
      if (AUTOMATED.has(mode) && !saveRunRecord({verify:true})) {
        outstandingDelivery = false; // es fand definitiv KEIN Sendeklick statt
        traceEvent('pending_ledger_write_failed');
        halt('Sicherheitsspeicher nicht verfügbar',
          'Die Versandmarkierung konnte nicht zuverlässig geschrieben und gelesen werden. Es wurde NICHT auf Senden geklickt. Browser-Speicher prüfen; vorhandenen Entwurf kontrollieren.');
        return;
      }
      if (!AUTOMATED.has(mode)) saveRunRecord();
      button.click(); // NIE automatisch erneut klicken: Dubletten vermeiden.
      traceEvent('send_button_clicked_once');
      sendStage = 'Versandbestätigung';
      logStatus('Sendeversuch läuft', 'Sendebutton einmal angeklickt. Prüfe, ob der Prompt übernommen wurde.');
      // Bei einem Wechsel in einen anderen Tab/ein anderes Fenster koennen
      // Hintergrund-Timer und Chat-DOM stark verzoegert aktualisiert werden.
      // Nur die 8s-Wall-Clock auszuwerten fuehrt zu falschen Abbruechen.
      // Nach dem einzigen Klick duerfen wir unbegrenzt im Hintergrund auf ein
      // STARKES Signal warten; bei Rueckkehr gilt erneut eine kurze Sichtpruefung.
      // Kein weiterer Klick und keine naechste Nachricht waehrend der Wartephase.
      let ackDeadline = Date.now() + SEND_ACK_WAIT_MS;
      let lastAckPollAt = Date.now();
      let observedForegroundEpoch = lastForegroundEpoch;
      let deferredReported = false;
      let confirmed = false;
      lastAckSignal = 'noch nicht bestätigt';
      editorClearedOnlyObserved = false;
      ackBackgroundPending = false;
      while (true) {
        const latestEditor = getEditor();
        // Editor-Leerung allein ist NIE ein gueltiges Versandsignal.
        if (!projectButton && latestEditor && editorEmpty(latestEditor) && !editorClearedOnlyObserved) {
          editorClearedOnlyObserved = true;
          traceEvent('editor_cleared_unverified');
          lastAckSignal = 'editor_cleared_unverified';
        }
        const ack = userNodes().length > beforeUser ? 'user_turn' : generating() ? 'generation_started'
          : assistantNodes().length > beforeAssistant ? 'assistant_turn' : '';
        if (ack) {
          confirmed = true;
          lastAckSignal = ack;
          traceEvent('send_ack:' + ack);
          break;
        }
        if (!allowed()) break;
        if (alertMessage()) { halt('ChatGPT meldet ein Problem', 'Fehlermeldung waehrend der Versandbestaetigung. Kein Zweitversuch.'); break; }
        const nowAck = Date.now();
        const inBackground = document.visibilityState === 'hidden' || windowAway;
        if (inBackground) {
          ackBackgroundPending = true;
          ackDeadline = Math.max(ackDeadline, nowAck + SEND_ACK_WAIT_MS);
          sendStage = 'Hintergrund: Versandpruefung offen';
          if (!deferredReported) {
            deferredReported = true;
            ackBackgroundDeferrals++;
            traceEvent('send_ack_deferred_background');
            logStatus('Versandprüfung im Hintergrund', 'Einmal geklickt, aber noch keine gesicherte Bestaetigung. Warte auf Turn/Generierung oder Rueckkehr ins Fenster. Kein Zweitversuch.');
          }
        } else {
          // Nach Fokus-/Sichtbarkeitswechsel nicht aufgrund einer alten
          // Deadline stoppen: DOM und Generierungsstatus brauchen Zeit.
          if (observedForegroundEpoch !== lastForegroundEpoch) {
            observedForegroundEpoch = lastForegroundEpoch;
            ackDeadline = Math.max(ackDeadline, nowAck + SEND_ACK_WAIT_MS, wakeGraceUntil + 3000);
            if (ackBackgroundPending) traceEvent('send_ack_foreground_recheck');
          }
          // Auch bei weiterhin 'visible' moeglich: anderes Programmfenster,
          // lange Timer-Drosselung oder kurzer Schlaf des Rechners.
          if (nowAck - lastAckPollAt >= ACK_SCHEDULER_GAP_MS) {
            ackDeadline = Math.max(ackDeadline, nowAck + SEND_ACK_WAIT_MS);
            traceEvent('send_ack_scheduler_delay');
          }
          if (nowAck >= ackDeadline && nowAck >= wakeGraceUntil) break;
        }
        lastAckPollAt = nowAck;
        await sleep(200);
      }
      ackBackgroundPending = false;
      if (!confirmed) {
        if (!running) return; // Freeze/Stopp/Entzug hat bereits beendet.
        sendStage = 'Versand nicht bestaetigt';
        halt('Versand unbestätigt', editorClearedOnlyObserved
          ? 'Editor wurde geleert, aber kein neuer Turn bzw. Generierungsbeginn bestaetigt. Kein zweiter Klick und keine weitere Nachricht.'
          : 'Einmal geklickt, aber keine bestaetigte Uebernahme. Kein automatischer Zweitversuch.');
        return;
      }
      // Während die ChatGPT-Seite den Klick bestätigt, kann die Nutzerin / der
      // Nutzer den Lauf stoppen. Ein bestätigter Klick reaktiviert den Lauf nie.
      if (!running || paused || !validatePath() || route !== exactChatRoute()) return;
      // The ACK may have seen the Stop/Generate button, but by this handoff
      // a fast answer (or a background tab) can already have finished.
      // Preserve that confirmed signal instead of forgetting the busy cycle.
      const busyNow = generating();
      const ackSawGeneration = lastAckSignal === 'generation_started';
      current = {
        beforeAssistant, beforeUser, sendAt: sent,
        sawBusy: ackSawGeneration || busyNow, sawAssistant: false, sawUser: userNodes().length > beforeUser,
        sawBusyEndAt: ackSawGeneration && !busyNow ? Date.now() : 0, lastAssistantActivityAt: sent,
        lastProgressAt: sent, firstAnswerAt: 0, continueClicks: 0,
        toolWasActive: false, toolFirstSeenAt: 0, toolLastSeenAt: 0, toolCompletionLogged: false,
        waitingAfterContinue: false, continueClickedAt: 0,
        afterContinueHadProgress: false
      };
      phase = 'await-start';
      sendStage = 'Übernommen (starkes Signal)';
      if (['project','continue-only'].includes(mode)) projectCount++;
      lastSentAt = sent;
      logStatus(['project','continue-only'].includes(mode) ? `Fortsetzungsnachricht ${projectCount} übergeben` : `Prompt ${completed + 1} übergeben`, 'Ein neuer Chat-Turn oder Generierungsbeginn wurde erkannt. Warte auf das Ende der Antwort.');
    } catch (error) {
      halt('Technischer Sendefehler', String(error?.message || error).slice(0, 150));
    } finally {
      sendingInProgress = false;
    }
  }

  function handleAnswer(now) {
    const c = current;
    if (!c) return;
    const warning = alertMessage();
    if (warning) { halt('ChatGPT meldet einen Fehler', warning); return; }
    const generatingNow = generating();
    const tool = toolActivity();
    const busy = generatingNow || tool.active;
    const assistantCount = assistantNodes().length;
    const userCount = userNodes().length;
    const newAssistant = assistantCount > c.beforeAssistant;
    const newUser = userCount > c.beforeUser;
    // Nach langem Background-Stillstand kann die Antwort inzwischen fertig sein.
    // Zuerst den aktuellen DOM-Zustand pruefen; abgelaufene Wall-Clock allein
    // ist kein Grund, eine fertig vorliegende Antwort zu verwerfen.
    if (userCount > c.beforeUser + 1) {
      halt('Zusätzliche Nachricht erkannt', 'Während der Queue wurde eine weitere User-Nachricht gesendet. Bitte prüfen.');
      return;
    }
    if (newUser) c.sawUser = true;
    if (newAssistant && !c.sawAssistant) {
      c.sawAssistant = true;
      c.firstAnswerAt = now;
      c.lastAssistantActivityAt = now;
      c.lastProgressAt = now;
      phase = 'streaming';
      logStatus(`Antwort ${completed + 1} erkannt`, 'Warte auf stabile Fertigstellung …');
    }
    if (busy) {
      if (generatingNow) c.sawBusy = true;
      if (c.sawBusy) c.sawBusyEndAt = 0;
      c.lastProgressAt = now;
      if (c.waitingAfterContinue) {
        c.waitingAfterContinue = false;
        c.afterContinueHadProgress = true;
        phase = 'streaming';
      }
    } else if (c.sawBusy && !c.sawBusyEndAt) {
      c.sawBusyEndAt = now;
      c.lastProgressAt = now;
    }
    if (tool.active) {
      if (!c.toolWasActive) {
        c.toolWasActive = true;
        c.toolFirstSeenAt = now;
        traceEvent('tool_wait_started');
        logStatus('Tool-Aufruf läuft', 'ChatGPT führt ein Werkzeug aus. CPQ wartet und sendet nichts Neues.');
      }
      c.toolLastSeenAt = now;
      c.toolCompletionLogged = false;
      c.lastAssistantActivityAt = now;
      phase = 'tool-running';
      if (now - c.toolFirstSeenAt >= TOOL_MAX_WAIT_MS) {
        halt('Tool-Aufruf benötigt Prüfung', 'Werkzeug meldet nach 60 Minuten weiterhin Aktivität. Kein automatischer Zweitversuch; Chat prüfen.');
      }
      return;
    }
    if (c.toolLastSeenAt) {
      if (!c.toolCompletionLogged) {
        c.toolCompletionLogged = true;
        traceEvent('tool_wait_ended');
        logStatus('Tool-Aufruf beendet – Antwortprüfung', 'Warte auf einen stabilen Antwortabschluss, bevor eine weitere Nachricht gesendet wird.');
      }
      if (now - c.toolLastSeenAt < TOOL_AFTER_QUIET_MS) {
        phase = 'tool-settling';
        return;
      }
    }
    // Reconcile the current DOM after waking BEFORE evaluating an old
    // wall-clock deadline. A complete response could have finished while
    // this tab was throttled, even if the thread is not parseable.
    if (now - c.sendAt >= TIMEOUT_MS && (busy || (!newAssistant && !c.sawBusyEndAt))) {
      halt('Antwortüberwachung abgebrochen', busy
        ? 'Nach 15 Minuten weiterhin eine laufende Generierung erkannt. Chat kontrollieren; kein zweiter Sendeklick.'
        : 'Nach 15 Minuten keine abgeschlossene Antwort erkennbar. Versand wurde bereits bestätigt, Antwort bleibt ungeklärt. Bitte Chat prüfen; kein automatischer Zweitversuch.'); return;
    }
    if (c.waitingAfterContinue) {
      if (!continueButton() && c.lastAssistantActivityAt > c.continueClickedAt) {
        c.waitingAfterContinue = false;
        c.afterContinueHadProgress = true;
        phase = 'streaming';
      } else if (now - c.continueClickedAt > CLICK_TIMEOUT_MS) {
        halt('„Weiter“ ohne Rückmeldung', 'Kein eindeutiger Fortsetzungsfortschritt; manuell prüfen.');
      }
      return;
    }
    if (!c.sawAssistant) {
      // Falls ChatGPT seine Nachrichten-Wrapper erneut aendert, kann die
      // bestaetigte Stop/Generate-Phase als konservativer Ersatz dienen.
      // Ohne erkennbaren Busy-Zyklus niemals blind eine weitere Nachricht senden.
      if (c.sawBusy && c.sawBusyEndAt && !busy && !continueButton()) {
        const editor = getEditor();
        const required = Number(ui.stability.value) * 1000;
        if (editor && editorEmpty(editor) && now - c.sawBusyEndAt >= required) {
          c.sawAssistant = true;
          c.firstAnswerAt = c.sawBusyEndAt;
          c.lastAssistantActivityAt = c.sawBusyEndAt;
          phase = 'settling';
          logStatus('Antwortende via Generierung bestätigt', 'Assistant-Turn fehlt, Stop-Button-Zyklus und Ruhephase sind jedoch bestätigt.');
          finishStep(now);
        }
        return;
      }
      if (now - Math.max(c.sendAt, c.toolLastSeenAt || 0) >= SEND_TIMEOUT_MS && !busy) halt('Antwort nicht erkannt', 'Weder neuer Assistant-Turn noch abgeschlossener Generierungszyklus sichtbar. Keine Dublette.');
      return;
    }
    if (busy) { phase = 'streaming'; return; }
    const continuation = continueButton();
    if (continuation) {
      if (paused || !ui.autoContinue.checked || mode === 'diagnose') {
        phase = 'needs-continue';
        if (!paused) {
          paused = true;
          logStatus('„Weiter“ erkannt', 'Automatisches Weiter ist deaktiviert. Bitte selbst klicken und dann fortsetzen.');
        }
        return;
      }
      if (c.continueClicks >= Number(ui.maxContinue.value)) {
        halt('Weiter-Limit erreicht', `${c.continueClicks} automatische Klicks für diese Antwort; bitte prüfen.`);
        return;
      }
      const settledFor = now - Math.max(c.sawBusyEndAt || c.sendAt, c.lastAssistantActivityAt);
      if (Date.now() < wakeGraceUntil || settledFor < AUTO_CONTINUE_QUIET_MS) return;
      if (runTimedOut()) return;
      c.continueClicks++;
      c.waitingAfterContinue = true;
      c.continueClickedAt = now;
      c.lastProgressAt = now;
      phase = 'await-continue';
      continuation.click();
      logStatus(`„Weiter“ ${c.continueClicks}× geklickt`, 'Prüfe, ob ChatGPT wirklich fortsetzt …');
      return;
    }
    const editor = getEditor();
    if (!editor || !editorEmpty(editor)) {
      halt('Eingabestatus unklar', 'Eingabefeld fehlt oder enthält Text. Keine weiteren Prompts.');
      return;
    }
    if (!c.sawUser && !c.sawBusy && !c.sawAssistant) {
      halt('Antwortstatus unklar', 'Keine bestätigte Eingabe und keine Generierung beobachtet.');
      return;
    }
    const quietFor = now - Math.max(c.lastAssistantActivityAt, c.sawBusyEndAt, c.firstAnswerAt, c.continueClickedAt || 0);
    const required = Number(ui.stability.value) * 1000;
    phase = 'settling';
    if (quietFor >= required && now - c.firstAnswerAt >= required) {
      if (c.continueClicks && !c.afterContinueHadProgress) {
        halt('Fortsetzung nicht bestätigt', '„Weiter“ wurde geklickt, aber ohne bestätigte Aktivität.');
        return;
      }
      finishStep(now);
    }
  }

  // Auto-Weiter ohne nativen Button: ein ganz normaler (editierbarer)
  // User-Prompt wird kontrolliert gesendet. Nie stillschweigend neu starten.
  function watchManualContinuation(now) {
    const m = manualContinue;
    if (!m || paused || current) return;
    const warning = alertMessage();
    if (warning) { halt('ChatGPT meldet einen Fehler', warning); return; }
    const coldStart = completed === 0 && projectCount === 0 && lastSentAt === 0;
    if (!hasLatestAssistantReply() && !coldStart && !m.allowWithoutTurn) return;
    if (userNodes().length !== m.userCount) {
      halt('Andere User-Nachricht erkannt', 'Unerwartete Chat-Aktivität. Bitte den Lauf erneut freigeben.');
      return;
    }
    const busy = generating() || toolActivity().active;
    if (m.pending) {
      if (busy || m.lastActivityAt > m.clickedAt) {
        m.pending = false; m.seenAt = 0; m.lastActivityAt = now;
        logStatus('Natives Weiter bestätigt', 'Beobachte den nächsten Abschluss.');
      } else if (now - m.clickedAt > CLICK_TIMEOUT_MS) {
        halt('Weiter nicht bestätigt', 'Nach dem Klick wurde keine eindeutige Antwortaktivität erkannt.');
      }
      return;
    }
    if (busy) { m.seenAt = 0; m.lastActivityAt = now; return; }
    const marker = hasLatestAssistantReply() ? projectMarker() : '';
    if (marker === 'FERTIG') { endRun('Aufgabe abgeschlossen', 'CPQ-FERTIG erkannt.'); return; }
    if (marker === 'PRUEFEN') { halt('Manuelle Prüfung erforderlich', 'CPQ-PRUEFEN erkannt.'); return; }
    const native = continueButton();
    if (native && ui.autoContinue.checked) {
      if (!m.seenAt) m.seenAt = now;
      if (Date.now() < wakeGraceUntil || now - Math.max(m.seenAt,m.lastActivityAt) < AUTO_CONTINUE_QUIET_MS) return;
      if (m.clicks >= Number(ui.maxContinue.value)) { halt('Natives Weiter-Limit', 'Zu viele native Weiter-Klicks.'); return; }
      if (runTimedOut()) return; // Kein neuer Klick nach dem Zeitlimit.
      m.pending = true; m.clicks++; m.clickedAt = now; m.seenAt = 0;
      native.click();
      logStatus(`Natives Weiter ${m.clicks}×`, 'Klick bestätigt; warte auf Antwortaktivität.');
      return;
    }
    if (native && !ui.autoContinue.checked) { halt('Nativer Weiter-Button sichtbar', 'Natives Weiter ist ausgeschaltet.'); return; }
    if (!ui.fallbackContinueText.checked) return;
    if (approvedBatchCount() >= Number(ui.maxProject.value)) {
      halt(strategyIsMarker()?'Batch-Limit erreicht':'Fortsetzungslimit erreicht', strategyIsMarker() ? `${approvedBatchCount()} Nachrichten im Paket beantwortet. Nächstes Paket nur mit neuer Startfreigabe.` : `${projectCount} automatische Nachrichten versendet. Keine Endlosschleife.`);return;
    }
    if (!ui.projectPrompt.value.trim()) { halt('Fortsetzungstext fehlt', 'Leerer Weiter-Prompt.'); return; }
    const editor = getEditor();
    if (!editor || (!editorEmpty(editor) && !approvedDraft())) { halt('Eingabe nicht bereit', 'Fremder Text bleibt unangetastet.'); return; }
    const waitMs = coldStart ? BOOTSTRAP_IDLE_MS : Number(ui.stability.value) * 1000;
    if (now - Math.max(m.lastActivityAt,m.firstObservedAt) < waitMs) return;
    if (lastSentAt && now - lastSentAt < MIN_SEND_GAP_MS) return;
    phase = 'ready'; nextSendAt = now;
    logStatus('Kein Weiter-Button nötig', `Fortsetzungsnachricht ${projectCount + 1}/${ui.maxProject.value} wird gesendet.`);
  }

  function heartbeat() {
    const now = Date.now();
    if (running && runTimedOut() && !sendingInProgress && !current) {halt('Zeitlimit erreicht','Kein neuer Versand nach Ablauf der freigegebenen Laufzeit.');return;}
    const sinceLast = Math.max(0, now - lastHeartbeatAt);
    lastHeartbeatAt = now;
    if (running && sinceLast >= SCHEDULER_GAP_MS) {
      lastSchedulerGapMs = sinceLast;
      traceEvent('scheduler_gap');
      // Nur sichtbare Wiederaufnahme braucht nochmals kurze Ruhestabilitaet;
      // unsichtbare, bloss gedrosselte Tabs duerfen weiterhin arbeiten.
      if (document.visibilityState !== 'hidden') delayOutgoingAfterResume('scheduler_resume');
    }
    if (running && (now < wakeGraceUntil || frozenDuringRun)) {
      // Waehrend der Wiederaufnahme kein Senden, keine Button-Klicks und
      // keine Entscheidung allein anhand verstrichener Uhrzeit.
      ui.diagnostics.textContent = monitorInfo() + '\nNächste Aktion: Rückkehrprüfung / Ruhezustand';
      if (frozenDuringRun) {
        frozenDuringRun = false; // Status nach dem Resume erneut beobachten
        if (sendingInProgress) {halt('Sendevorgang beim Einfrieren unklar', 'Kein Zweitversuch. Bitte den Chat und eigenen Entwurf pruefen.');return;}
      }
      if (now < wakeGraceUntil) {reportBadge();return;}
    }
    // Diagnose funktioniert auch ohne laufende Queue.
    ui.diagnostics.textContent = monitorInfo() + `\nNächste Aktion: ${!running ? 'Start → Lauf bestätigen' : paused ? 'Pausiert' : current ? 'Warte auf Antwort' : phase === 'project-initial' || (mode === 'continue-only' && projectCount === 0) ? 'Erststart nach Leerlauf-Prüfung' : phase === 'ready' ? 'Weiter-Nachricht einfügen und senden' : 'Beobachten'}`;
    if (!running) syncChatSettingsRoute();
    if (awaitingRunApproval && exactChatRoute() !== preflightRoute) { dismissPreflight(); logStatus('Chat gewechselt', 'Alte Startfreigabe verworfen.'); }
    if (AUTOMATED.has(ui.mode.value)) redrawScope();
    if (!running) return;
    if (AUTOMATED.has(mode) && !approvedHere()) { halt('Freigabe fehlt', 'Dieser Chat ist nicht mehr explizit für Automatik freigegeben.'); return; }
    if (mode === 'diagnose') {
      if (!validatePath()) endRun('Chat gewechselt', 'Diagnose beendet.');
      return;
    }
    if (mode === 'continue-only') {
      if (!validatePath()) { halt('Chat gewechselt', 'Auto-Weiter angehalten.'); return; }
      if (current) { handleAnswer(now); return; }
      if (paused) return;
      if (phase === 'ready' && now >= nextSendAt) { void sendNext(); return; }
      watchManualContinuation(now);
      return;
    }
    if (mode === 'project' && phase === 'project-initial') {
      if (paused) return;
      if (!validatePath()) { halt('Chat gewechselt', 'Projekt-Autopilot angehalten.'); return; }
      if (alertMessage()) { halt('ChatGPT meldet ein Problem', 'Bitte Fehler-/Limitmeldung selbst pruefen.'); return; }
      if (generating() || toolActivity().active) { projectInitialActivityAt = now; return; }
      if (manualContinue?.pending || continueButton()) {
        if (!ui.autoContinue.checked) { halt('Natives Weiter sichtbar', 'Aktiviere natives Auto-Weiter oder setze manuell fort.'); return; }
        if (!manualContinue) manualContinue = {userCount:userNodes().length,clicks:0,seenAt:0,pending:false,clickedAt:0,lastActivityAt:now};
        watchManualContinuation(now);
        if (manualContinue?.pending || continueButton()) return;
      }
      // Cold start: Nach bewusster Lauf-Freigabe darf der bereits idle Chat
      // auch ohne CPQ-Marker und ohne erkannten Assistant-Turn fortgesetzt werden.
      // Ein noch laufender Chat bleibt durch generating() oben blockiert.
      if (!getEditor() || (!editorEmpty(getEditor()) && !approvedDraft())) { halt('Eingabe nicht bereit', 'Das Eingabefeld enthaelt einen anderen Entwurf oder fehlt.'); return; }
      const coldDelay = hasLatestAssistantReply() ? Number(ui.stability.value) * 1000 : BOOTSTRAP_IDLE_MS;
      if (now - projectInitialActivityAt >= coldDelay) checkProjectMarker(now, true);
      else if (message === 'Projekt-Autopilot scharfgeschaltet') logStatus('Starte im ruhenden Chat', `Keine Antwort-Erkennung zum Start nötig. Warte auf leeres Feld, ${Math.ceil(coldDelay/1000)} s Ruhe, dann sende Weiter.`);
      return;
    }
    if (!validatePath()) { halt('Chat gewechselt', 'Kein automatischer weiterer Versand.'); return; }
    if (current) {
      handleAnswer(now); // Auch in Pause Abschluss/Beschädigung erkennen; aber nie automatisch weiterklicken.
      return;
    }
    if (paused) return;
    if (phase === 'ready' && now >= nextSendAt && (mode === 'project' || completed < queue.length)) void sendNext();
  }

  let awaitingRunApproval = false;
  let preflightRoute = '';
  let approvalGranted = false;
  function dismissPreflight() {
    awaitingRunApproval = false;
    preflightRoute = '';
    ui.preflight.hidden = true;
  }
  ui.cancelStart.addEventListener('click', () => {
    dismissPreflight();
    logStatus('Nicht gestartet', 'Es wurde keine automatische Aktion ausgeführt.');
  });
  ui.confirmStart.addEventListener('click', () => {
    if (!awaitingRunApproval || running) return;
    if (!exactChatRoute() || preflightRoute !== exactChatRoute() || !approvedHere()) {
      dismissPreflight(); logStatus('Freigabe veraltet', 'Chatwechsel oder Freigabe entzogen. Bitte neu starten.'); return;
    }
    awaitingRunApproval = false;
    approvalGranted = true;
    ui.preflight.hidden = true;
    ui.start.click();
  });
  for (const el of [ui.preset, ui.queue, ui.mode, ui.stability, ui.maxContinue, ui.autoContinue, ui.maxProject, ui.projectPrompt, ui.projectClick, ui.fallbackMissingMarker, ui.fallbackContinueText, ui.loopGuard, ui.checkpointEvery, ui.runStrategy, ui.durationHours]) {
    el.addEventListener('input', () => { if (awaitingRunApproval) dismissPreflight(); });
    el.addEventListener('change', () => { if (awaitingRunApproval) dismissPreflight(); });
  }
  const requiresPreflight = new Set(['auto', 'project', 'continue-only']);
  ui.start.addEventListener('click', () => {
    if (running) return;
    syncChatSettingsRoute();
    if (configLoading || configRoute !== exactChatRoute()) {
      logStatus('Chat-Einstellungen werden geladen', 'Modus wird für diesen Chat neu eingelesen. Bitte danach Start erneut wählen.');
      return;
    }
    mode = ui.mode.value;
    // Auch ein NEUER Lauf darf einen alten ungeklaerten Klick nicht wiederholen.
    // Diagnose bleibt ohne Versandfunktion moeglich.
    if (mode !== 'diagnose' && guardUnresolvedPreviousDelivery()) return;
    if (AUTOMATED.has(mode) && !approvedHere()) { abortBeforeRun('Automatik gesperrt', 'Zuerst global und exakt diesen Chat freigeben.'); return; }
    if (requiresPreflight.has(mode) && !approvalGranted) {
      if(resumeRequest && !recoveryEligible(readLedger()))resumeRequest=null;
      const messages = ui.queue.value.split(/^\s*===\s*$/m).map(s => s.trim()).filter(Boolean);
      const actions = mode === 'auto' ? messages.map((m,i) => `${i+1}. ${m}`).join('\n\n')
        : mode === 'project' ? `Projekt: Maximal ${ui.maxProject.value} Nachricht(en). Ohne Marker: ${ui.fallbackMissingMarker.checked ? 'JA' : 'NEIN'}.\n${ui.projectPrompt.value.trim()}\nCPQ-Button: ${ui.projectClick.checked ? 'Ja' : 'Nein'}`
        : `Auto-Weiter: nativer Button max ${ui.maxContinue.value} Klicks; eigene Nachrichten: ${ui.fallbackContinueText.checked ? 'Ja, max '+ui.maxProject.value : 'Nein'}.\nNachricht: ${ui.projectPrompt.value.trim()}`;
      const policyInfo = ['project','continue-only'].includes(mode) ? `Fortsetzungsziel: ${ui.runStrategy.value==='marker' ? 'Bis FERTIG; jeweils neues Paket ausdrücklich freigeben' : 'Nachrichtenlimit'}; Paket bis ${ui.maxProject.value}.` : 'Vorgegebene Prompt-Reihe.';
      preflightRoute = exactChatRoute();
      ui.preflightSummary.textContent = `Ziel: ${location.host}${location.pathname}. Modus: ${mode}. ${policyInfo} Laufzeit: ${durationDescription()}. Alles nur in diesem offenen Tab.` + ((mode === 'project' || mode === 'continue-only') && Number(ui.maxProject.value) > 10 ? ` Achtung: Langer Lauf mit bis zu ${ui.maxProject.value} Fortsetzungsnachrichten!` : '');
      ui.preflightText.textContent = (resumeRequest ? `WIEDERAUFNAHME ab beantwortetem Schritt ${resumeRequest.completed}; erneut explizit freigeben.\n\n` : '') + (actions || '(keine Nachrichten vorhanden)') + (approvedDraft() ? '\n\nHINWEIS: Ein exakt passender Entwurf liegt bereits im ChatGPT-Eingabefeld. Nach der Freigabe wird er gesendet.' : '');
      ui.preflight.hidden = false;
      ui.panel.scrollTop = 0; // Die Bestätigung steht direkt unter dem fixierten Kopfbereich.
      awaitingRunApproval = true;
      logStatus('Freigabe erforderlich', 'Vor Start die vollständigen automatischen Aktionen bestätigen.');
      return;
    }
    dismissPreflight();
    const selected = ui.queue.value.split(/^\s*===\s*$/m).map(s => s.trim()).filter(Boolean);
    if (mode !== 'diagnose' && mode !== 'continue-only' && mode !== 'project' && selected.length === 0) { abortBeforeRun('Kein Prompt', 'Mindestens einen Prompt eingeben.'); return; }
    if (AUTOMATED.has(mode) && ['project','continue-only'].includes(mode) && (!Number.isInteger(Number(ui.maxProject.value)) || Number(ui.maxProject.value) < 1 || Number(ui.maxProject.value) > MAX_AUTO_MESSAGES)) { abortBeforeRun('Ungültiges Fortsetzungslimit', 'Wähle höchstens 50 Nachrichten pro bestätigtem Lauf.'); return; }
    if (selected.length > MAX_STEPS) { abortBeforeRun('Zu viele Schritte', `Maximal ${MAX_STEPS} Prompts je Durchlauf.`); return; }
    if (!['diagnose', 'continue-only', 'project'].includes(mode) && (generating() || continueButton())) {
      abortBeforeRun('ChatGPT arbeitet noch', 'Bitte eine laufende Antwort selbst abschließen, bevor du startest.'); return;
    }
    if (!['diagnose', 'continue-only'].includes(mode) && (!getEditor() || (!editorEmpty(getEditor()) && !approvedDraft()))) {
      abortBeforeRun('Eingabe nicht bereit', 'Das Eingabefeld muss leer und erreichbar sein.'); return;
    }
    if (AUTOMATED.has(mode) && (!exclusiveLockRelease || exclusiveLockRoute !== exactChatRoute())) {
      if (exclusiveLockRelease) releaseExclusiveLock();
      requestExclusiveLock(exactChatRoute());
      return;
    }
    approvalGranted = false;
    queue = selected;
    const acceptedRecovery=!!resumeRequest && resumeRequest.mode===mode && resumeRequest.runStrategy===ui.runStrategy.value && recoveryEligible(readLedger());
    completed = acceptedRecovery ? resumeRequest.completed : 0;
    projectCount = acceptedRecovery ? resumeRequest.projectCount : 0;
    batchBaseCount = strategyIsMarker() ? projectCount : 0;
    runDeadlineAt = Number(ui.durationHours.value) ? Date.now()+Number(ui.durationHours.value)*60*60*1000 : 0;
    restoredFromLedger = acceptedRecovery;
    resumeRequest = null;
    safeCounts = null;
    outstandingDelivery = false;
    priorReplyGrams = null;
    consecutiveSimilar=0;haltedForLoop=false;
    // Diagnose ist schreibgeschuetzt: vorhandene ungeklaerte Lieferungen
    // weder loeschen noch durch einen "neuen" leeren Lauf ersetzen.
    runKnown = mode !== 'diagnose';
    storedRunRoute = runKnown ? exactChatRoute() : '';
    running = true;
    paused = false;
    current = null;
    manualContinue = mode === 'continue-only' ? {
      userCount: userNodes().length, clicks: 0, seenAt: 0,
      pending: false, clickedAt: 0, lastActivityAt: Date.now(), firstObservedAt: Date.now()
    } : null;
    lastSentAt = 0;
    pathAtStart = location.pathname;
    phase = mode === 'diagnose' ? 'diagnose' : mode === 'continue-only' ? 'continue-only' : mode === 'project' ? 'project-initial' : 'ready';
    projectInitialActivityAt = Date.now();
    nextSendAt = Date.now() + 400;
    persist();
    logStatus(mode === 'diagnose' ? 'Diagnose aktiv' : mode === 'continue-only' ? 'Auto-Weiter aktiv' : mode === 'project' ? 'Projekt-Autopilot scharfgeschaltet' : 'Reihe gestartet', mode === 'diagnose' ? 'Beobachtet nur; sendet und klickt nichts.' : mode === 'continue-only' ? 'Sendet nach bestätigtem Start auch im bereits ruhenden Chat selbst Weiter, bis zum Limit.' : mode === 'project' ? 'Führt nach bestätigtem Start auch ohne letzte erkannte Assistant-Antwort im ruhenden Chat den ersten Weiter-Prompt aus.' : `${selected.length} Prompt(s) · ${mode === 'auto' ? 'Automatik' : 'Freigabemodus'}.`);
  });
  ui.quickStart.addEventListener('click', () => {
    if (running || !storageReady || (AUTOMATED.has(ui.mode.value) && !approvedHere())) return;
    if (unresolvedPreviousDelivery()) {
      logStatus('Vorheriger Versand ungeklärt', 'Schnellstart gesperrt: zuerst den letzten Versand im Chat prüfen.');
      return;
    }
    traceEvent('quickstart_preflight');
    ui.panel.scrollTop = 0;
    ui.start.click(); // immer reguläre Vorschau / Bestätigung; keine Umgehung
  });
  ui.approve.addEventListener('click', () => {
    if (!running || current || phase !== 'ready' || completed >= queue.length) return;
    paused = false;
    nextSendAt = Date.now();
    logStatus('Freigegeben', `Prompt ${completed + 1} wird gesendet.`);
  });
  ui.pause.addEventListener('click', () => {
    if (!running) return;
    paused = !paused;
    logStatus(paused ? 'Pausiert' : 'Fortgesetzt', paused ? 'Keine weiteren automatischen Klicks oder Prompts.' : 'Fortsetzung unter den eingestellten Schutzregeln.');
  });
  ui.sendNow.addEventListener('click', () => {
    if (!running || paused || current || !['project','continue-only'].includes(mode)) return;
    if (!approvedHere() || !exclusiveLockRelease || exclusiveLockRoute !== exactChatRoute()) return;
    if (runTimedOut()) {halt('Zeitlimit erreicht','Keine neue Fortsetzung nach Ablauf.');return;}
    if (approvedBatchCount() >= Number(ui.maxProject.value)) { halt(strategyIsMarker()?'Batch-Limit erreicht':'Fortsetzungslimit erreicht', 'Keine weitere Fortsetzung ohne Freigabe.'); return; }
    if (generating() || toolActivity().active || continueButton()) { logStatus('Noch aktiv', 'Laufende Antwort, Tool-Aufruf oder natives Weiter zuerst abschließen.'); return; }
    if (!getEditor() || (!editorEmpty(getEditor()) && !approvedDraft())) { logStatus('Eingabe nicht leer', 'Vorhandenen anderen Entwurf erst selbst bearbeiten.'); return; }
    phase = 'ready'; nextSendAt = Date.now();
    logStatus('Weiter manuell freigegeben', 'Der nächste Heartbeat fügt den Weiter-Prompt ein und sendet ihn.');
  });
  ui.stop.addEventListener('click', () => endRun('Gestoppt', 'Bereits gesendete Prompts oder laufende Antworten bleiben im Chat.'));
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(SCOPE_KEY, obj => initScope(obj?.[SCOPE_KEY]));
  } else {
    try { initScope(typeof GM_getValue === 'function' ? GM_getValue(SCOPE_KEY,'') : localStorage.getItem(SCOPE_KEY)); }
    catch (_) { initScope(''); }
  }
  // Freigabe-Aenderungen aus anderen Tabs beruecksichtigen; fehlende/ungueltige Daten sperren.
  function applyRemoteScope(raw) {
    const normalized = typeof raw === 'string' ? raw : JSON.stringify(raw || {});
    if (normalized === lastScopeSerialized) return;
    initScope(raw);
    if (running && AUTOMATED.has(mode) && !approvedHere()) {
      halt('Freigabe extern widerrufen', 'Andere Registerkarte hat die Freigabe entzogen.');
    }
  }
  if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[SCOPE_KEY]) applyRemoteScope(changes[SCOPE_KEY].newValue);
    });
  } else if (typeof GM_getValue === 'function') {
    setInterval(() => { try { applyRemoteScope(GM_getValue(SCOPE_KEY,'')); } catch (_) { applyRemoteScope(''); } }, 2000);
  } else {
    window.addEventListener('storage', ev => { if (ev.key === SCOPE_KEY) applyRemoteScope(ev.newValue || ''); });
  }
  // Sichtbarkeit ist keine Freigabebedingung: Ein Hintergrund-Tab darf
  // nach der ausdruecklichen Startfreigabe weiterlaufen. Aufwachen aus
  // Freeze erfordert jedoch erneute Stabilitaetskontrolle.
  document.addEventListener('visibilitychange', () => {
    lifecycleState = document.visibilityState === 'hidden' ? 'hintergrund' : 'sichtbar';
    if (document.visibilityState === 'visible') {lastForegroundEpoch = Date.now(); delayOutgoingAfterResume('tab_visible');}
    reportBadge();
    heartbeat();
  });
  document.addEventListener('freeze', () => {
    lifecycleState = 'eingefroren';
    if (running) {
      frozenDuringRun = true;
      traceEvent('tab_frozen');
      // Chrome empfiehlt, Web Locks vor dem Einfrieren freizugeben.
      // Ohne erneute Freigabe nach dem Auftauen keine automatischen Aktionen.
      halt('Tab eingefroren', 'Chrome hat den Tab eingefroren. Tab-Sperre freigegeben; vor einem neuen Lauf Chatstatus pruefen und Start erneut bestaetigen.');
    }
    reportBadge();
  });
  document.addEventListener('resume', () => {
    lifecycleState = document.visibilityState === 'hidden' ? 'hintergrund' : 'sichtbar';
    lastForegroundEpoch = Date.now();
    delayOutgoingAfterResume('tab_resumed');
    heartbeat();
  });
  window.addEventListener('blur', () => {
    windowAway = true;
    if (running && sendingInProgress) traceEvent('window_unfocused_during_send');
  });
  window.addEventListener('focus', () => {
    windowAway = false;
    lastForegroundEpoch = Date.now();
    delayOutgoingAfterResume('window_focused');
    heartbeat();
  });
  window.addEventListener('pageshow', e => {
    if (e.persisted) {lastForegroundEpoch = Date.now(); delayOutgoingAfterResume('page_restored'); heartbeat();}
  });
  window.addEventListener('pagehide', () => {
    if(running) saveRunRecord();
    running = false;
    releaseExclusiveLock();
    reportBadge();
  });
  observeConversation();
  positionLauncher();
  render();
  reportBadge();
  setInterval(heartbeat, POLL_MS);
  setInterval(positionLauncher, 4000);
})();
