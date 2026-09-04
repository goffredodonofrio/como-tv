/**
 * ═══════════════════════════════════════════════════════════════════
 *  PORTARE QUI UN VIDEO — da un file o da un link
 * ═══════════════════════════════════════════════════════════════════
 *
 *  Lo usano la Regia (finestra "Carica contributo") e la scheda Contributi.
 *  Stava dentro regia.html: copiarlo nella scheda nuova avrebbe voluto dire
 *  due implementazioni che dopo un mese non si somigliano piu'.
 *
 *  Tre strade, e il chiamante non deve sapere quale:
 *   · un file MP4 dal computer, spedito a pezzi
 *   · un link che si puo' mandare in onda cosi' com'e' (YouTube, Vimeo, un
 *     .mp4 raggiungibile)
 *   · un link che invece va PORTATO QUI dal ponte, perche' quel sito non
 *     lascia riprodurre i suoi file altrove (Google Drive)
 */
window.VideoLink = (function () {
  "use strict";

  // ── che cos'e' questo link ──────────────────────────────────────────
  //   k: "video"    → al lettore video, cosi' com'e'
  //   k: "web"      → una finestra: e' una pagina, non un file
  //   k: "preleva"  → prima lo scarica il ponte, poi diventa un video nostro
  //   k: "cartella" → non e' un file: si sceglie che cosa c'e' dentro
  function leggi(u) {
    u = String(u || "").trim();
    if (!u) return null;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;

    var t = 0;
    var m = u.match(/[?&]t=(\d+)/) || u.match(/[?&]start=(\d+)/);
    if (m) t = parseInt(m[1], 10) || 0;

    var y = u.match(/(?:youtube\.com\/(?:watch\?[^#]*\bv=|embed\/|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (y) {
      return { k: "web", che: "YouTube",
        // enablejsapi serve a poterlo comandare dopo: parte muto perche' se no
        // non parte, e appena e' avviato gli si toglie il muto dal playout
        src: "https://www.youtube.com/embed/" + y[1] +
             "?autoplay=1&mute=1&enablejsapi=1&controls=0&modestbranding=1&rel=0&playsinline=1&iv_load_policy=3" +
             (t ? "&start=" + t : ""),
        nota: "Parte muto — i player non partono da soli con l’audio — e il muto viene tolto " +
              "appena parte. Se il tuo browser lo blocca resta muto: nel vMix di solito funziona." };
    }

    var cart = u.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([A-Za-z0-9_-]{10,})/);
    if (cart) return { k: "cartella", che: "Cartella Drive", id: cart[1] };

    // Google non lascia suonare i suoi file da un altro sito: sull'indirizzo
    // che serve il contenuto mette cross-origin-resource-policy: same-site e
    // content-disposition: attachment, e il lettore video li rifiuta. Al ponte
    // pero' il file lo da' — li' non c'e' un'origine da vietare — quindi lo
    // scarica lui, e da quel momento e' roba nostra: parte da sola e non
    // dipende da Google mentre si trasmette.
    var g = u.match(/(?:drive|docs)\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[^#]*&)?id=)([A-Za-z0-9_-]{10,})/);
    if (g) {
      return { k: "preleva", che: "Google Drive",
        src: "https://drive.usercontent.google.com/download?id=" + g[1] + "&export=download&confirm=t",
        nota: "Google non lascia riprodurre i suoi file da un altro sito — e non dipende da come " +
              "l’hai condiviso. <b>Lo porta qui il ponte</b>: lo scarica una volta e va in onda da " +
              "questa macchina, senza dipendere da Google mentre trasmetti." };
    }

    var v = u.match(/vimeo\.com\/(?:video\/)?(\d{6,})/);
    if (v) {
      return { k: "web", che: "Vimeo",
        src: "https://player.vimeo.com/video/" + v[1] + "?autoplay=1&muted=1&title=0&byline=0&portrait=0" +
             (t ? "#t=" + t + "s" : ""),
        nota: "Parte muto — i player non partono da soli con l’audio — e il muto viene tolto " +
              "appena parte. Se il tuo browser lo blocca resta muto: nel vMix di solito funziona." };
    }

    if (/\.(mp4|webm|m4v|mov)(\?|$)/i.test(u)) {
      return { k: "video", che: "file video", src: u,
        nota: "Va al lettore video: loop, muto e ultimo fotogramma funzionano." };
    }
    return { k: "web", che: "pagina web", src: u,
      nota: "Parte <b>muto</b>: con l’audio i player non partono da soli." };
  }

  // ── il colloquio col ponte ──────────────────────────────────────────
  function posta(cfg, corpo) {
    return fetch(cfg.ponte, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ token: cfg.token }, corpo)) })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j.ok) throw new Error(j.errore || "errore"); return j; });
  }

  // ── un file dal computer ────────────────────────────────────────────
  // Pezzi da 8 MB, tre alla volta: il ponte li scrive alla posizione giusta,
  // quindi l'ordine di arrivo non conta.
  function durataDi(f) {
    return new Promise(function (res) {
      var v = document.createElement("video");
      v.preload = "metadata";
      v.src = URL.createObjectURL(f);
      v.addEventListener("loadedmetadata", function () { res(v.duration || 0); URL.revokeObjectURL(v.src); });
      v.addEventListener("error", function () { res(0); });
    });
  }
  function caricaFile(f, cfg, avanti) {
    var PEZZO = 8 * 1048576, tot = Math.ceil(f.size / PEZZO), fatti = 0;
    var offs = []; for (var o = 0; o < f.size; o += PEZZO) offs.push(o);
    return Promise.all([durataDi(f), posta(cfg, { tipo: "video-inizia", nome: f.name, tot: f.size })])
      .then(function (r) {
        var dur = r[0], ini = r[1];
        function operaio() {
          if (!offs.length) return Promise.resolve();
          var off = offs.shift();
          return f.slice(off, Math.min(off + PEZZO, f.size)).arrayBuffer().then(function (buf) {
            var b = "", u = new Uint8Array(buf);
            for (var i = 0; i < u.length; i += 0x8000) b += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
            return posta(cfg, { tipo: "video-pezzo", id: ini.id, off: off, dati: btoa(b) });
          }).then(function () {
            fatti++;
            if (avanti) avanti(Math.round(fatti / tot * 100), "Carico " + f.name + "…");
            return operaio();
          });
        }
        return Promise.all([operaio(), operaio(), operaio()])
          .then(function () { return posta(cfg, { tipo: "video-fine", id: ini.id }); })
          .then(function (fine) { return { file: fine.file, dur: dur }; });
      });
  }

  // ── un link che va portato qui: lo scarica il ponte ─────────────────
  function prelevaLink(url, nome, cfg, avanti) {
    return posta(cfg, { tipo: "video-preleva", url: url, nome: nome }).then(function (via) {
      return new Promise(function (ok, no) {
        var tentativi = 0;
        (function guarda() {
          if (++tentativi > 900) { no(new Error("il prelievo non finisce piu’")); return; }
          fetch(cfg.ponte + "?preleva=" + encodeURIComponent(via.id), { cache: "no-store" })
            .then(function (r) { return r.json(); })
            .then(function (st) {
              if (st.errore) { no(new Error(st.errore)); return; }
              if (avanti) {
                var mb = (st.scritti / 1048576).toFixed(0);
                avanti(st.tot ? Math.max(3, Math.round(st.scritti / st.tot * 100)) : 3,
                       st.tot ? "Scarico: " + mb + " di " + (st.tot / 1048576).toFixed(0) + " MB…"
                              : "Scarico: " + mb + " MB…");
              }
              if (st.fatto) { ok(st); return; }
              setTimeout(guarda, 700);
            })
            .catch(no);
        })();
      });
    });
  }

  // ── che cosa c'e' in una cartella di Drive ──────────────────────────
  function cartella(id, cfg) { return posta(cfg, { tipo: "drive-cartella", id: id }); }

  return { leggi: leggi, caricaFile: caricaFile, prelevaLink: prelevaLink,
           cartella: cartella, durataDi: durataDi };
})();
