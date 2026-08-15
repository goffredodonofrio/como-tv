// Auto-positioning foto nei formati banner
// Rileva i visi e li centra automaticamente

var faceDetectionReady = false;

// Carica face-api.js (face detection lato-client)
function initFaceDetection() {
  if (faceDetectionReady) return;

  var script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js';
  script.async = true;
  script.onload = function() {
    console.log('✓ face-api.js caricato');
    faceDetectionReady = true;
    // Carica i modelli per il rilevamento
    loadFaceModels();
  };
  document.head.appendChild(script);
}

var modelsLoaded = false;
async function loadFaceModels() {
  if (modelsLoaded) return;
  try {
    const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model/';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL)
    ]);
    modelsLoaded = true;
    console.log('✓ Face detection modelli caricati');
  } catch(e) {
    console.warn('Errore caricamento face detection:', e);
  }
}

function autoPositionPhotoInBanner() {
  if (!faceDetectionReady || !modelsLoaded || !SHIMG.photo) return;

  // Prova a rilevare i visi e posiziona la foto
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = async function() {
    try {
      // Rileva i visi
      const detections = await faceapi.detectAllFaces(img, new faceapi.TinyFaceDetector());

      if (detections.length > 0) {
        console.log('✓ Rilevati ' + detections.length + ' visi');
        // Centra il primo viso
        var face = detections[0];
        var faceX = face.box.x + face.box.width / 2;
        var faceY = face.box.y + face.box.height / 2;

        // Calcola offset per centrare il viso nel formato corrente
        var format = getFormatName(current);
        applyAutoPositioning(faceX, faceY, img.width, img.height, format);
      } else {
        console.log('⚠️ Nessun viso rilevato, uso smart positioning');
        smartPositionPhoto(img.width, img.height);
      }
    } catch(e) {
      console.warn('Errore rilevamento visi:', e);
      smartPositionPhoto(img.width, img.height);
    }
  };
  img.src = SHIMG.photo;
}

function smartPositionPhoto(imgWidth, imgHeight) {
  // Posizionamento intelligente se face detection non funziona
  var format = getFormatName(current);

  if (!format) return;

  var item = BYKEY[format];
  if (!item) return;

  // Se la foto è portrait (più alta che larga), posiziona in alto (dove è il viso)
  if (imgHeight > imgWidth) {
    // Portrait: mostra top
    STATE[format].adj.photo = STATE[format].adj.photo || {};
    STATE[format].adj.photo.dy = -Math.abs(imgHeight - item.h) / 3; // Sposta in alto
    console.log('📸 Portrait: posizionato in alto');
  } else {
    // Landscape: centra
    STATE[format].adj.photo = STATE[format].adj.photo || {};
    STATE[format].adj.photo.dy = 0;
    console.log('📸 Landscape: posizionato al centro');
  }

  renderStage();
  refreshThumbs();
}

function applyAutoPositioning(faceX, faceY, imgWidth, imgHeight, format) {
  if (!format) return;

  var item = BYKEY[format];
  if (!item) return;

  // Centra il viso nel formato
  var offsetX = (item.w / 2) - faceX;
  var offsetY = (item.h / 2) - faceY;

  // Limita gli offset per non mostrare aree vuote
  offsetX = Math.max(-(imgWidth - item.w), Math.min(0, offsetX));
  offsetY = Math.max(-(imgHeight - item.h), Math.min(0, offsetY));

  STATE[format].adj.photo = STATE[format].adj.photo || {};
  STATE[format].adj.photo.dx = offsetX;
  STATE[format].adj.photo.dy = offsetY;

  console.log('📸 Viso centrato:', {dx: offsetX, dy: offsetY});

  renderStage();
  refreshThumbs();
}

function getFormatName(key) {
  if (!key || !ITEMS) return null;
  var item = ITEMS.find(it => it.key === key);
  return item ? item.key : null;
}

// Hook: quando carichi una foto, attiva auto-positioning
var originalLoadNat = loadNat;
loadNat = function(src, cb) {
  originalLoadNat(src, function(result) {
    if (cb) cb(result);
    // Prova auto-positioning dopo che la foto è caricata
    setTimeout(autoPositionPhotoInBanner, 500);
  });
};

// Inizializza al caricamento della pagina
window.addEventListener('load', function() {
  setTimeout(initFaceDetection, 1000);
});
