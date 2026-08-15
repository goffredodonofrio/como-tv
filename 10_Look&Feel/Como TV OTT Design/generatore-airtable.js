// Estensione Generatore OTT ↔ Airtable
// Legge events.json e popola il pannello "Importa prossimi 14 giorni"

var EVENTS_DATA = [];

function loadEventsJSON() {
  // Prova a caricare events.json
  fetch('events.json')
    .then(r => r.json())
    .then(data => {
      EVENTS_DATA = Array.isArray(data) ? data : data.events || [];
      renderEventPanel();
    })
    .catch(() => {
      // Se non esiste, mostra un messaggio
      console.log('events.json non trovato. Usa il panel "Importa" per caricare gli eventi.');
    });
}

function renderEventPanel() {
  // Aggiunge il pannello "Importa prossimi 14 giorni" nel fieldsCard
  var fc = document.getElementById('fieldsCard');
  if (!fc) return;

  // Crea la sezione "Importa"
  var importSec = document.createElement('div');
  importSec.className = 'step';
  var stepSpan = document.createElement('span');
  stepSpan.className = 'n';
  stepSpan.textContent = '3';
  importSec.appendChild(stepSpan);
  importSec.appendChild(document.createTextNode('Importa da Airtable'));
  fc.appendChild(importSec);

  var card = document.createElement('div');
  card.className = 'card';

  if (EVENTS_DATA.length === 0) {
    card.innerHTML = '<p style="color: var(--fg3); font-size: 12px;">Nessun evento trovato in events.json</p>';
  } else {
    var select = document.createElement('select');
    select.appendChild(createOption('', '— Scegli partita —'));

    EVENTS_DATA.forEach((evt, idx) => {
      var label = (evt.home || 'Home') + ' vs ' + (evt.away || 'Away')
        + ' · ' + (evt.date || '')
        + ' · ' + (evt.compBase || '');
      select.appendChild(createOption(idx, label));
    });

    select.onchange = function() {
      if (!this.value) return;
      var evt = EVENTS_DATA[parseInt(this.value)];
      applyEventToGenerator(evt);
    };

    card.appendChild(select);

    // Bottone "Carica foto"
    var photoBtnLabel = document.createElement('label');
    photoBtnLabel.style.display = 'block';
    photoBtnLabel.style.marginTop = '8px';
    photoBtnLabel.textContent = 'Foto (da Airtable)';
    card.appendChild(photoBtnLabel);

    var photoSel = document.createElement('select');
    photoSel.appendChild(createOption('', '— Nessuna —'));
    photoSel.id = 'eventPhotoSelect';
    card.appendChild(photoSel);
  }

  fc.appendChild(card);
}

function createOption(val, text) {
  var opt = document.createElement('option');
  opt.value = val;
  opt.textContent = text;
  return opt;
}

function applyEventToGenerator(evt) {
  // Popola SHARED con i dati dell'evento
  if (typeof SHARED === 'undefined') return;

  // Azzera undo stack per chiarezza
  if (typeof pushUndo === 'function') pushUndo();

  SHARED.home = evt.home || 'Home';
  SHARED.away = evt.away || 'Away';
  SHARED.compBase = evt.compBase || '';
  SHARED.comp = evt.compBase + ' · ' + (evt.round || '');
  SHARED.round = evt.round || '';
  SHARED.date = evt.date || '';
  SHARED.time = evt.time || '';
  SHARED.compKey = evt.compKey || '';
  SHARED.english = evt.english || false;
  SHARED.preshow = evt.preshow || '';

  // Se esiste una foto, caricala
  if (evt.photoURL) {
    if (typeof SHIMG !== 'undefined') {
      SHIMG.photo = evt.photoURL;
    }
  }

  // Se esiste un logo competizione
  if (evt.logoURL) {
    if (typeof SHIMG !== 'undefined') {
      SHIMG.logoComp = evt.logoURL;
    }
  }

  // Re-render il pannello e il canvas
  if (typeof renderControls === 'function') renderControls();
  if (typeof renderStage === 'function') renderStage();
  if (typeof refreshThumbs === 'function') refreshThumbs();
}

function autoGenerateAll14Days() {
  // Genera PNG per tutti gli eventi (batch)
  // Da implementare insieme al backend che popola events.json
  if (EVENTS_DATA.length === 0) {
    alert('Nessun evento disponibile. Carica events.json prima.');
    return;
  }

  var results = [];

  EVENTS_DATA.forEach((evt, idx) => {
    applyEventToGenerator(evt);
    // Qui andrebbe il codice per catturare il PNG dell'attuale formato
    // Per ora, solo log
    results.push({
      index: idx,
      match: evt.home + ' vs ' + evt.away,
      status: 'ready'
    });
  });

  console.log('Batch generation ready:', results);
  // Da implementare: download automatico dei PNG
}

// Carica gli eventi al caricamento della pagina
window.addEventListener('load', function() {
  setTimeout(loadEventsJSON, 500);
});
