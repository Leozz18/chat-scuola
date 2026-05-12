# Chat scuola — lobby e stanze

## Perché esiste questo progetto

A scuola abbiamo un **server Debian** con Apache/PHP in rete locale: volevo un modo semplice per **scrivere con gli amici** senza app esterne, account complicati o database da amministrare.  
È nata questa chat: **solo file PHP + JavaScript**, persistenza in un **unico file JSON** (`stanze.php`), così la si può copiare in una cartella del vhost, dare i permessi di scrittura e usarla subito dalla LAN.

> **Nota:** rispetta sempre le regole della scuola sull’uso della rete e dei server. Questo README è tecnico; l’uso responsabile spetta a chi la installa.

---

## Cosa fa (in breve)

- **Lobby** con elenco stanze (aggiornamento periodico).
- **Stanze pubbliche o private** (le private richiedono approvazione dell’host).
- **Messaggi in tempo quasi reale** tramite polling HTTP (nessun WebSocket obbligatorio).
- **Crittografia opzionale E2EE** (AES nel browser con **CryptoJS**): il server vede solo blob cifrati; la password stanza **non** viene mai inviata al server.
- **Lavagna condivisa**, sondaggi, reazioni, risposte citate (anche a **immagini**), spunte di lettura, export della cronologia, allegati, menzioni, e altro (vedi sotto).

---

## Requisiti

- **PHP 8+** con estensioni usuali (`json`, `mbstring` consigliata).
- Un web server (**Apache** o **Nginx** + `php-fpm`) che serva i file dalla cartella del progetto.
- Browser moderni (JavaScript abilitato).

Non serve **MySQL** né altri DB: i dati vivono in `stanze.php` (file PHP “protetto” che contiene JSON).

---

## Setup su Debian (produzione / server scuola)

1. **Clona o copia** la cartella del progetto nella root del sito (es. `/var/www/html/chat-scuola/`).

2. **Crea il file dati** (non è in Git per evitare di versionare messaggi reali):
   ```bash
   cp stanze.php.example stanze.php
   ```

3. **Permessi di scrittura** (l’utente del web server deve poter aggiornare `stanze.php`):
   ```bash
   sudo chown www-data:www-data stanze.php
   sudo chmod 664 stanze.php
   ```
   Se la cartella non è scrivibile e l’API fallisce in scrittura, verifica anche il gruppo e SELinux/AppArmor se attivi.

4. **Apri il sito** dal browser: `http://IP-DEL-SERVER/chat-scuola/` (o il path che hai configurato).

5. **HTTPS:** in ambiente reale è preferibile usare TLS (anche con certificato interno) così il traffico HTTP non circola in chiaro sulla rete.

---

## Setup in locale (es. Windows + XAMPP)

1. Metti la cartella sotto `htdocs` (es. `C:\xampp\htdocs\chat scuola`).
2. Copia `stanze.php.example` in `stanze.php` se non esiste già.
3. Avvia **Apache** da XAMPP e apri `http://localhost/chat%20scuola/` (attenzione agli spazi nel nome cartella).

---

## Struttura file principale

| File | Ruolo |
|------|--------|
| `index.html` | Interfaccia (login, lobby, stanza, modali). |
| `app.js` | Logica client: polling, cifratura, UI, lavagna, comandi. |
| `style.css` | Stili (layout fullscreen in stanza, dark mode, ecc.). |
| `api.php` | API JSON: `lobby`, `create_room`, `fetch`, `send`, … |
| `stanze.php` | **Dati runtime** (stanze, messaggi, presenza). **Non versionato** (vedi `.gitignore`). |
| `stanze.php.example` | Template vuoto `{}` per inizializzare `stanze.php`. |

L’app parla solo con `api.php` (GET/POST + JSON).

---

## Chicche e funzioni utili

- **E2EE opzionale** alla creazione / entrata stanza: messaggi e allegati sensibili restano leggibili solo chi ha la chiave nel browser.
- **Incolla immagini** (Ctrl+V) nel campo messaggio; **drag & drop** file piccoli.
- **Markdown leggero** e blocchi codice (tripli backtick).
- **Comandi** tipo `/nick`, `/me`, `/poll`, `/burn`, `/clear` (alcuni solo effetto locale).
- **Lavagna** sincronizzata via messaggi dedicati (anche con E2EE).
- **Lista utenti online** e stato (chat / lavagna).
- **Risposte citate**; per le **immagini** citazione compatta senza reinviare tutto il Base64.
- **Reazioni** e **spunte di lettura** (con coda se il tab è in background).
- **Export chat** (testo) dall’header stanza.
- **Boss key** / schermata finta (easter egg): controlla la tastiera nell’app per i dettagli.

La modale **Aiuto** nell’interfaccia riassume sicurezza e comandi.

---

## Limiti da tenere a mente

- **Polling**, non WebSocket: più utenti e intervalli corti significano più richieste al server.
- Il server memorizza al massimo **100 messaggi** per stanza (vedi `MAX_MESSAGES` in `api.php`); i più vecchi vengono scartati quando si supera il limite.
- **Nessun audit enterprise**: adatta backup e permessi se il server è condiviso.

---

## Licenza e contributi

Progetto personale / scolastico.

---

*Buona chat, e buon Debian.*
