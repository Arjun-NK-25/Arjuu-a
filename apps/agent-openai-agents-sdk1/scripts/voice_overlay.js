/*
 * Voice command overlay for the Databricks chat UI (e2e-chatbot-app-next).
 *
 * - Mic button: browser speech-to-text (Web Speech API). Live transcription
 *   goes into the chat textarea; when you stop speaking, the message is sent
 *   automatically. Click the mic again while listening to cancel.
 * - Speaker button: toggle text-to-speech for new assistant replies.
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
  wrap.append(statusPill, micBtn, ttsBtn);
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

  micBtn.addEventListener('click', function () {
    if (listening) {
      // second click cancels: stop and do not send
      autoSend = false;
      stopListening();
      pill('Voice input cancelled');
      return;
    }
    if (!SR) {
      pill('Speech recognition not supported here — use Chrome or Edge');
      return;
    }
    finalText = '';
    autoSend = true;
    recog = new SR();
    recog.continuous = false;
    recog.interimResults = true;
    recog.lang = navigator.language || 'en-US';

    recog.onresult = function (event) {
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
    };

    recog.onend = function () {
      micBtn.classList.remove('on');
      listening = false;
      if (autoSend && finalText.trim()) {
        setTimeout(function () {
          setTA(finalText.trim());
          sendMessage();
          pill('');
        }, 250);
      } else if (!finalText.trim() && autoSend) {
        pill('');
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
    }
  });

  /* ---------- text-to-speech for replies ---------- */

  var ttsOn = false;
  var stableText = '';
  var lastSpoken = '';

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
    if (!ttsOn || !('speechSynthesis' in window)) return;
    if (document.querySelector('[data-testid="message-assistant-loading"]')) {
      stableText = ''; // still generating; wait for it to settle
      return;
    }
    var msgs = document.querySelectorAll('[data-testid="message-assistant"]');
    if (!msgs.length) return;
    var content = msgs[msgs.length - 1].querySelector('[data-testid="message-content"]');
    var text = cleanReplyText((content || msgs[msgs.length - 1]).innerText || '');
    if (!text) return;
    if (text === stableText) {
      if (text !== lastSpoken && !window.speechSynthesis.speaking) {
        lastSpoken = text;
        var u = new SpeechSynthesisUtterance(text.slice(0, 2000));
        u.lang = navigator.language || 'en-US';
        window.speechSynthesis.speak(u);
      }
    } else {
      stableText = text; // remember and re-check after streaming settles
    }
  }, 1200);
})();
