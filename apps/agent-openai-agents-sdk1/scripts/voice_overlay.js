/*
 * Voice command overlay for the Databricks chat UI (e2e-chatbot-app-next).
 *
 * - Mic button: browser speech-to-text (Web Speech API). Live transcription
 *   goes into the chat textarea; when you stop speaking, the message is sent
 *   automatically. Click the mic again while listening to cancel.
 * - Speaker button: toggle text-to-speech for new assistant replies.
 * - Hands-free button (headset): voice-activated conversation. The mic opens
 *   automatically, your speech is sent when you finish talking, the reply is
 *   spoken aloud, and the mic re-opens when the reply ends. The setting is
 *   remembered across page loads and the session resumes automatically.
 *
 * Injected into client/index.html by scripts/voice_patch.py at app startup,
 * before `npm run build`.
 */
(function () {
  'use strict';
  if (window.__voiceOverlay) return;
  window.__voiceOverlay = true;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var TA_SEL = '[data-testid="multimodal-input"]';
  var HF_KEY = 'voiceHandsFree';

  var style = document.createElement('style');
  style.textContent =
    '.voice-cmd{position:fixed;right:18px;bottom:96px;display:flex;flex-direction:column;gap:8px;z-index:9999}' +
    '.voice-cmd button{width:42px;height:42px;border-radius:9999px;display:flex;align-items:center;justify-content:center;' +
    'background:#fff;color:#333;border:1px solid rgba(0,0,0,.15);box-shadow:0 2px 8px rgba(0,0,0,.18);cursor:pointer;transition:background .2s}' +
    '.voice-cmd button:hover{background:#f1f1f1}' +
    '@media (prefers-color-scheme:dark){.voice-cmd button{background:#1f1f1f;color:#eee;border-color:rgba(255,255,255,.2)}' +
    '.voice-cmd button:hover{background:#333}}' +
    '.voice-cmd button.on{background:#e5484d;color:#fff;border-color:transparent}' +
    '.voice-cmd .pill{font:11px/1.4 system-ui,sans-serif;padding:4px 10px;border-radius:9999px;background:rgba(0,0,0,.8);' +
    'color:#fff;text-align:center;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}';
  document.head.appendChild(style);

  var MIC_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M11 5a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z"/>' +
    '<path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" x2="12" y1="19" y2="22"/></svg>';
  var SPK_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>' +
    '<path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
  var HF_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z"/>' +
    '<path d="M21 14h-3a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-5Z"/>' +
    '<path d="M21 14v-2a9 9 0 0 0-18 0v2"/></svg>';

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  var wrap = el('div', 'voice-cmd');
  var statusPill = el('div', 'pill', '');
  statusPill.style.display = 'none';
  var micBtn = el('button', '', MIC_SVG);
  micBtn.title = 'Voice command: click, speak, and your message is sent automatically';
  var ttsBtn = el('button', '', SPK_SVG);
  ttsBtn.title = 'Read agent replies aloud';
  var hfBtn = el('button', '', HF_SVG);
  hfBtn.title = 'Hands-free: voice-activated conversation with spoken replies';
  wrap.append(statusPill, micBtn, ttsBtn, hfBtn);
  document.body.appendChild(wrap);

  function pill(msg, sticky) {
    statusPill.textContent = msg;
    statusPill.style.display = msg ? '' : 'none';
    if (msg && !sticky) {
      setTimeout(function () {
        if (!listening) pill('');
      }, 2600);
    }
  }

  /* ---------- speech-to-text ---------- */

  var recog = null;
  var listening = false;
  var finalText = '';
  var autoSend = true;
  var silentTurns = 0;
  var handsFree = false;
  var ttsOn = false;
  var stableText = '';
  var lastSpoken = '';
  try { handsFree = window.localStorage.getItem(HF_KEY) === '1'; } catch (e) {}

  function setTA(text) {
    var ta = document.querySelector(TA_SEL);
    if (!ta) return null;
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return ta;
  }

  function sendMessage() {
    var ta = document.querySelector(TA_SEL);
    if (!ta || !ta.value || !ta.value.trim()) return; // never send empty
    var form = ta.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    }
  }

  function stopListening() {
    listening = false;
    micBtn.classList.remove('on');
    if (recog) {
      try { recog.stop(); } catch (e) { /* already stopped */ }
    }
    if (!statusPill.textContent) pill('');
  }

  function startListening() {
    if (listening) return;
    if (!SR) {
      pill('Speech recognition not supported here — use Chrome or Edge');
      if (handsFree) setHandsFree(false);
      return;
    }
    finalText = '';
    autoSend = true;
    recog = new SR();
    recog.continuous = false;
    recog.interimResults = true;
    recog.lang = navigator.language || 'en-US';

    recog.onresult = function (event) {
      silentTurns = 0;
      var interim = '';
      for (var i = event.resultIndex; i < event.results.length; i++) {
        var r = event.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      var ta = setTA((finalText + ' ' + interim).trim());
      if (ta) ta.focus();
    };

    recog.onerror = function (e) {
      var messages = {
        'not-allowed': 'Microphone permission denied',
        'no-speech': "Didn't catch that — try again",
        'network': 'Speech service unreachable',
        'audio-capture': 'No microphone found'
      };
      if (e.error !== 'aborted') pill(messages[e.error] || 'Voice error: ' + e.error);
      if (handsFree && (e.error === 'not-allowed' || e.error === 'audio-capture' || e.error === 'network')) {
        setHandsFree(false);
      }
    };

    recog.onend = function () {
      micBtn.classList.remove('on');
      listening = false;
      if (autoSend && finalText.trim()) {
        silentTurns = 0;
        setTimeout(function () {
          setTA(finalText.trim());
          sendMessage();
          pill('');
        }, 250);
      } else if (handsFree) {
        // Silent or cancelled turn: keep the hands-free session alive and
        // re-open the mic for another attempt. After several silent turns in
        // a row, pause so the microphone does not stay on forever.
        silentTurns++;
        if (silentTurns >= 5) {
          silentTurns = 0;
          setHandsFree(false);
          pill('Hands-free paused after silence — click the headset to resume');
        } else {
          setTimeout(function () {
            if (handsFree && !listening) startListening();
          }, 900);
        }
      }
      finalText = '';
    };

    try {
      recog.start();
      listening = true;
      micBtn.classList.add('on');
      pill('Listening…', true);
    } catch (e) {
      pill('Could not start the microphone');
      if (handsFree) setHandsFree(false);
    }
  }

  micBtn.addEventListener('click', function () {
    if (handsFree) {
      // In hands-free mode the mic button pauses or resumes the session.
      if (listening) setHandsFree(false);
      else startListening();
      return;
    }
    if (listening) {
      // second click cancels: stop and do not send
      autoSend = false;
      stopListening();
      pill('Voice input cancelled');
      return;
    }
    startListening();
  });

  /* ---------- hands-free (voice-activated) mode ---------- */

  function setHandsFree(on) {
    handsFree = on;
    try { window.localStorage.setItem(HF_KEY, on ? '1' : '0'); } catch (e) {}
    hfBtn.classList.toggle('on', on);
    if (on) {
      if (window.speechSynthesis) {
        ttsOn = true;
        ttsBtn.classList.add('on');
      }
      pill('Hands-free on — speak now', true);
      startListening();
    } else {
      autoSend = false;
      stopListening();
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      ttsOn = false;
      ttsBtn.classList.remove('on');
      pill('Hands-free off');
    }
  }

  hfBtn.addEventListener('click', function () {
    setHandsFree(!handsFree);
  });

  // Resume a saved hands-free session when the page loads. Some browsers
  // need one click on the page first (microphone / autoplay policy); a
  // one-time document click retries in that case.
  if (handsFree) {
    hfBtn.classList.add('on');
    if (window.speechSynthesis) {
      ttsOn = true;
      ttsBtn.classList.add('on');
    }
    setTimeout(function () {
      if (handsFree && !listening) startListening();
    }, 1000);
    document.addEventListener('click', function () {
      if (handsFree && !listening) startListening();
    }, { once: true });
  }

  /* ---------- text-to-speech for replies ---------- */

  ttsBtn.addEventListener('click', function () {
    ttsOn = !ttsOn;
    ttsBtn.classList.toggle('on', ttsOn);
    if (!window.speechSynthesis) {
      ttsOn = false;
      ttsBtn.classList.remove('on');
      pill('Text-to-speech not supported in this browser');
      return;
    }
    if (ttsOn) {
      pill('Replies will be spoken aloud');
    } else {
      window.speechSynthesis.cancel();
      stableText = '';
      pill('Speaking disabled');
    }
  });

  function cleanReplyText(t) {
    return t
      .replace(/^\s*(Copy|Retry|Edit|Reasoning|Thinking)\s*$/gm, '')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  setInterval(function () {
    if (!('speechSynthesis' in window)) return;
    if (document.querySelector('[data-testid="message-assistant-loading"]')) {
      stableText = ''; // still generating; wait for it to settle
      return;
    }
    var msgs = document.querySelectorAll('[data-testid="message-assistant"]');
    if (!msgs.length) return;
    var content = msgs[msgs.length - 1].querySelector('[data-testid="message-content"]');
    var text = cleanReplyText((content || msgs[msgs.length - 1]).innerText || '');
    if (!text) return;
    if (text !== stableText) {
      stableText = text; // remember and re-check after streaming settles
      return;
    }
    if (text === lastSpoken) return;
    // The reply has settled. Speak it when enabled; in hands-free mode the
    // microphone re-opens once the spoken reply has finished.
    if (ttsOn && !window.speechSynthesis.speaking) {
      lastSpoken = text;
      var u = new SpeechSynthesisUtterance(text.slice(0, 2000));
      u.lang = navigator.language || 'en-US';
      u.onend = function () {
        if (handsFree && !listening) setTimeout(startListening, 400);
      };
      window.speechSynthesis.speak(u);
    } else if (handsFree && !listening) {
      lastSpoken = text;
      setTimeout(startListening, 400);
    }
  }, 1200);
})();
