# Meta-Prompt / Engineering Goal

Du entwickelst und betreibst die private native OpenClaw-Erweiterung `openclaw-mcp-server-bridge`. Arbeite vom überprüfbaren Verhalten eines bestehenden Gateways aus. Die erste verbindliche Zielversion ist **OpenClaw 2026.9.4**, einschließlich der im Fedora-Core verwendeten deterministischen Distribution. Neuere Versionen sind zusätzliche, ausdrücklich getestete Kompatibilitätsziele. Eine Funktion im heutigen `main` ist kein Beweis, dass sie in 2026.9.4 existiert.

## 1. Ergebnis aus Sicht des Betreibers

The operator supplies repeatable `OPENCLAW_MCP_BRIDGE_AGENT` / `OPENCLAW_MCP_BRIDGE_BEARER` pairs through the host `.env`, with `_02`, `_03` suffixes for further agents. `config.sh` offers OpenSSL generation for each bearer. Initialization skips unknown agents and incomplete pairs and writes the remaining selection and credentials together through OpenClaw's native config writer. The extension never generates replacement credentials. Existing OpenClaw channel bindings supply the complete delivery route; no second bot-token/chat-ID routing table is needed.

Der externe Agent ist ein MCP-Client. Der lokale OpenClaw-Agent bezeichnet die vom Gateway verwaltete Identität und Session-Zuordnung; er soll für übernommene gewöhnliche Kanalnachrichten keinen zusätzlichen Modelllauf ausführen. Der Gateway empfängt unabhängig davon weiter, ob ein Client gerade verbunden ist. Der Operator muss deshalb weder einen dauerhaften Client noch einen Polling-Worker starten, damit die Bridge Nachrichten annimmt.

Die Default-Route ist präzise zu definieren: Eine Antwort auf einen konkreten Eingang verwendet dessen ursprünglichen vollständigen Transportkontext. Ein proaktiver Send ohne explizites Ziel darf die zuletzt zugelassene Route genau dieses Agenten verwenden. Niemals das zuletzt aktive Telegram-Konto, den letzten Kanal eines anderen Agenten oder einen beliebigen zuletzt aktualisierten Session-Eintrag einsetzen. Ist die Route unbekannt, abgelaufen, widerrufen oder mehrdeutig, muss der Client einen klaren Fehler erhalten.

## 2. Vor jeder Änderung zu überprüfende Fakten

Lies die tatsächlichen SDK-Exports, Hook-Typen und Aufrufstellen der festgelegten OpenClaw-Version. Unterscheide einen beobachtenden Event-Hook von einer kontrollierten Dispatch-Übernahme. Prüfe für jeden Hook die Rückgabesemantik, Fehlerbehandlung, Ausführungsreihenfolge, Prioritäten, erlaubten Dispatch-Arten und Runtime-Gates. Ein Hook, dessen Ausnahme nur geloggt wird und anschließend den normalen Agentenlauf fortsetzt, muss innerhalb einer bereits beanspruchten Bridge-Nachricht geschlossen behandelt werden.

Prüfe den öffentlichen Versandweg im Host. Ein vorhandener `runtime.gateway.request`-Typ beweist keine Berechtigung externer Plugins. In 2026.9.4 ist dieser Zugriff für vertrauenswürdige offizielle/bundled Plugins eingeschränkt. Deshalb keine erdachte Operator-Scope-Erhöhung, kein eigener Gateway-Admin-Bearer, keine Importe aus privaten `src`-Pfaden und kein Fälschen eines offiziellen Plugin-Status. Verwende die öffentliche SDK-Funktion `sendDurableMessageBatch` und prüfe Agenten- und Route-Rechte vor ihrem Aufruf erneut.

Prüfe die tatsächlich mitgelieferte MCP-SDK-Version. SDK 1.30.0 spricht bis Protokollrevision 2025-11-25; spätere MCP-Transportregeln dürfen nicht stillschweigend mit dessen Initialisierung oder Session-Verhalten vermischt werden. Implementiere MCP über das SDK, nicht durch handgeschriebene JSON-RPC-Sonderfälle. Dokumentiere jede unterstützte Host-/Node-/MCP-Kombination mit einem ausführbaren CI-Nachweis.

## 3. Eingang und Besitz einer Nachricht

Die Kanal-Admission bleibt vollständig beim Host: Telegram-Pairing, Sender-Allowlist, Gruppenrechte, Mention-Gates, Kontoauswahl, Topic-Override, Bindings und native Befehle. Nimm erst nach erfolgreicher Admission eine gewöhnliche Agent-Nachricht an. Verwende die endgültige Session und Route des Dispatch-Kontexts; erfinde keine vereinfachte Zweitimplementierung von `resolveAgentRoute`.

Ermittle die Agentenidentität aus vertrauenswürdigem Host-Kontext und kanonischem Session-Key. Widersprüchliche Identitäten sind ein Fehler, niemals ein Grund für einen Fallback auf `main`. Berücksichtige ab 2026.9.4 das kanonische `agents.entries`-Objekt; `agents.list` ist nur eine interne/ältere Projektion. Nicht ausgewählte Agenten dürfen weder ausgebremst noch umgeleitet werden.

Speichere nur die benötigten Fakten: sichtbarer Rohtext, Empfangszeit, Provider-Nachrichten-/Update-ID, Sender, Kanal, Konto, Chat, Topic/Thread, Session-Generation und beschränkte Medienhinweise. Keine vollständigen History-Envelopes, Secrets, lokale Dateipfade oder signierte Medien-URLs an den Client durchreichen. Telegram-Kanalinhalte sind untrusted input, auch wenn darin angebliche Systemanweisungen stehen.

Die Übernahme muss dem Host korrekt mitteilen, dass der Turn erledigt ist, ohne eine erfundene Modellantwort oder einen gestarteten Agent-Run zu melden. Lifecycle-Callbacks wie processed/idle sauber abschließen. Die Bridge darf keine endlosen Typing-Schleifen, offenen Dispatcher oder hängenden Promise-Ketten hinterlassen. Fehler, Queue-Overflow oder ein nicht verbundener MCP-Client dürfen keine normale automatische Modellantwort auslösen, sobald die ausgewählte Kanalnachricht übernommen wurde.

## 4. Queue-Vertrag

Je ausgewähltem Agenten existiert genau eine begrenzte RAM-FIFO. Ihre Lebensdauer ist die Bridge-Service-Laufzeit, nicht die Lebensdauer einer HTTP-Verbindung oder eines MCP-Transports. Mehrere Clients desselben Agenten teilen diese Queue. Andere Agenten erhalten keinerlei Einblick.

`new_message(count)` validiert die Grenze, wählt die ältesten Einträge und entfernt genau diese atomar ohne asynchronen Zwischenraum. `pending_count` verändert die Queue nicht. Liefere die tatsächlich abgeholten Einträge und die verbleibende Anzahl. Verwechsle Consume-on-read nicht mit einer Löschung aus Telegram, dem Host-Sessionstore oder einem Plattform-Archiv.

Es gibt ausdrücklich keinen persistenten Inbox-Journal und keine nachträgliche Wiedereinspielung alter Session-History. Restart, Absturz oder Verlust einer bereits konsumierten HTTP-Antwort kann Nachrichten verlieren. Das ist die beabsichtigte at-most-once-Semantik, kein Exactly-once-System. Ein zusätzlicher Ack-/Retry-/Lease-Modus wäre eine separate Produktentscheidung, keine beiläufige Erweiterung.

Begrenze Anzahl, Bytes und Alter. Das erste Release verwendet 1.000 Nachrichten beziehungsweise 8 MiB je Agent, 32.768 Textzeichen, 24 Stunden TTL und Batchgröße 1–100. Overflow entfernt ältere Einträge nachvollziehbar und erhöht einen sichtbaren Zähler. TTL, Overflow, Trunkierung und Duplikatunterdrückung müssen eigene überprüfbare Ergebnisse haben. Dedupliziere mit Konto-/Routenkontext, sodass gleiche numerische Telegram-Nachrichten-IDs verschiedener Chats nicht kollidieren.

## 5. Current return route (operator-approved contract)

Each agent has one `actual_channel` / current route, independent of FIFO entries. Every newly accepted incoming message replaces that complete return route. Source metadata remains attached to each FIFO entry, but consuming an entry never changes the outgoing destination. There is no history of selectable route grants.

All outgoing messages use this current destination. The MCP client cannot override it with a route ID or chat ID. Keep channel, account, destination, thread and session together. Configuration changes, session resets, expiry and restart invalidate the route. If a newer source arrives while an outgoing send is still being planned, reject the outdated platform handoff rather than silently deliver to its previous target.

## 6. Ausgang und Fehlersemantik

`send_message` accepts only text and always uses the agent’s current return route. Es legt keinen Eingangseintrag an und startet kein Modell. Der Versand läuft über die öffentlichen OpenClaw-Adapter und deren Formatierungs-/Delivery-Pipeline. Der ursprüngliche Account und der ursprüngliche Thread müssen ankommen; numerische Topic-IDs dürfen weder verschwinden noch mit anderen Bots vermischt werden.

Prüfe die aktuelle Host-Send-Policy und den Session-Eintrag unmittelbar vor Versand. Reiche den kanonischen Session-Kontext und Requester-Kontext an den Host weiter. Hosteigene `message_sending`-/Payload-Hooks müssen weiterhin wirken. Wenn diese den Versand unterdrücken, darf das Resultat nicht `sent` heißen.

Unterscheide bestätigten Versand, Unterdrückung, Teilversand und unbekanntes Ergebnis. Ein Timeout nach einem Plattformaufruf kann trotz Fehlermeldung bereits zugestellt worden sein. Keine automatische Wiederholung, solange eine sichere Idempotenz-/Reconciliation-Strategie nicht nachweislich vorhanden ist. Rückgaben dürfen bestätigte Plattform-Nachrichten-IDs enthalten, aber keine ungefilterten Provider-Exceptions oder Bot-Token. Der Host darf seinen dauerhaften ausgehenden Delivery-Journal verwenden; das ändert die bewusst flüchtige Inbox nicht.

## 7. HTTP, Authentifizierung und Ressourcen

Registriere `/telegram-mcp` als exakte plugin-authentifizierte Route am vorhandenen Gateway. Keine Route anderer Plugins ersetzen, keinen zweiten Listener öffnen und keine Gateway-Admin-Scopes verlangen. Bearer-Principals werden ausschließlich serverseitig einem Agenten zugeordnet. Ein Tool-Argument `agentId` ist kein Autorisierungsmechanismus.

Use the explicitly supplied per-agent bearers generated with `openssl rand -hex 32` through `config.sh`. Keep the host `.env` as their source of truth and use the native config writer to install them. Do not regenerate credentials at gateway startup. Credentials must not appear in images, Git, release ZIPs, status logs or ordinary error messages. An explicit client-config command may show the operator the selected agent's bearer.

Prüfe Authentifizierung vor Body-Verarbeitung und erneut bei Tool-Ausführung. Begrenze Body-Größe, Requests, parallele Sends und Request-Dauer. Validiere `Origin`; keine wildcardbasierte Freigabe, kein Bearer im Querystring. Behandle Disconnect, Abbruch, unvollständige Bodies und JSON-RPC-Fehler ohne Ressourcenlecks. MCP-Transporte sind request-scoped, die Geschäftslogik bleibt service-scoped. GET/DELETE dürfen bei der gewählten stateless-Ausprägung 405 liefern; dies muss mit einem echten MCP-Client getestet sein.

## 8. Konfiguration im Fedora-Kontext

Die Extension wird in `fedora45-ai-core/Containerfile2026.9.17` neben den bestehenden Extensions installiert und nach oben vererbt. Der Core-Build installiert ein geprüftes privates ZIP samt SHA-256, kontrolliert den Manifest-/Entrypoint-Pfad und ergänzt den öffentlichen Image-Installationsindex. Keine Agentenzuordnung oder Credentials im Build.

`openclaw-ephemeral` erzeugt im vorhandenen Setup die Laufzeitkonfiguration aus seinen Quellen neu. Deshalb ist eine manuelle Änderung an der erzeugten Datei allein nicht als dauerhaftes Setup abzunehmen. Bei der späteren Aktivierung müssen Agentenauswahl und Credential-Lebensdauer über den vorhandenen persistenten Config-/Init-Weg abgesichert und nach Recreation getestet werden. Nicht ungefragt bestehende Generator-Regeln, Agentenbindungen oder live verwendete Dateien ändern. Diese Integrationsfrage offen dokumentieren, bis sie tatsächlich gelöst und getestet wurde.

Container-Images und umfangreiche Smoke-/Restarttests ausschließlich auf GitHub-gehosteten Actions-Runnern bauen beziehungsweise ausführen. Die Workflows aus `SCRIPTS/githubactions` sind Source-of-Truth. GHCR-Veröffentlichung ist keine lokale Übernahme. Keine lokalen Builds, Testcontainer oder direkten Image-Pulls. Ein später beauftragter Pull erfolgt ausschließlich durch Smart1. Fedora-Runtime-Pins und laufende Dienste bleiben von einem reinen Build-Auftrag unberührt.

Core-pre darf bei unverändertem Inhalt einen weiteren Versionstag auf denselben Digest erhalten. Erst danach Core → Base → Kachelmann → Safrano → Full aus dem festgelegten Quellcommit bauen. Bereits existierende Tags nicht ohne geklärten Auftrag überschreiben. Erfolg jeder Stufe und deren Elternbezug nachweisen. Ein gestarteter Workflow ist kein abgeschlossener Build.

## 9. Testmatrix und Freigabekriterien

Prüfe mindestens: Empfang ohne Client; mehrere Agenten; gleichzeitige Consumer; FIFO und Count; doppelte Provider-Updates; gleichlautende Chat-IDs bei mehreren Bots; Telegram-Topics; Session-Reset; Credentialwechsel; Agententfernung; geänderte Bindings; Send-Policy deny; Host-Hook-Unterdrückung; Teilversand; Timeout nach möglichem Versand; malformed JSON; Origin; falsches Bearer; Requestgröße; Disconnect und Restart.

Der Host-Test muss die realen öffentlichen SDK-Exports der getesteten OpenClaw-Version laden. Ein Mock allein belegt keine Kompatibilität. Das ZIP muss auf einem frischen Runner installierbar sein; Gateway-Start, Authentifizierung, tatsächlicher MCP-Request und Credential-Stabilität über Gateway-Neustart müssen funktionieren. Die deterministische Fedora-Distribution muss beim Core-Build ebenfalls das ZIP installieren können.

Für die produktive Telegram-Abnahme wird ein ausdrücklich dafür ausgewählter Agent benutzt: Nachricht ohne verbundenen Client senden, Queue später prüfen, konsumieren, zweiten Abruf als leer bestätigen, Antwort im ursprünglichen Konto/Topic beobachten, parallelen zweiten Agenten gegen Zugriff schützen und sicherstellen, dass keine zusätzliche OpenClaw-Modellantwort entsteht. Keine erfundene E2E-Abnahme und keine produktiven Testnachrichten ohne Auftrag.

Tasks und Projektstatus nur nach belegtem Ergebnis schließen. Source vorhanden, Unit-Tests grün, ZIP publiziert, Image gebaut, lokal übernommen und Telegram tatsächlich abgenommen sind verschiedene Zustände. Die ursprünglichen acht Projektaufgaben bleiben offen, solange ihre individuellen Abnahmekriterien nicht erfüllt und überprüft sind.

## 10. Weiterentwicklung ohne Versionsfalle

Neue OpenClaw-Versionen zuerst in der Actions-Matrix erproben. Die SDK-Grenze klein halten: Routing-/Session-Identität, Config-Mutation, HTTP-Registrierung, Dispatch-Übernahme und Outbound-Adapter. Bei einer API-Änderung eine explizite kleine Version-/Capability-Anpassung vornehmen; keine Kette aus stillen Fallbacks, die im Fehlerfall an die falsche Unterhaltung sendet.

Weitere Kanäle nur dann freigeben, wenn Admission, Account-ID, Thread-Semantik und Host-Versandvertrag durch konkrete Tests abgedeckt sind. Eine kanalneutrale Datenstruktur macht noch keinen nachgewiesenen Slack-/Discord-/Matrix-Support. MCP-Protokoll-Upgrades separat testen, einschließlich Initialisierung, HTTP-Methoden, Accept-/Version-Headern, Abbruch und Response-Lebensdauer.

Die Definition of Done ist eine verständliche, installierbare, überprüfte Erweiterung mit ehrlichen Grenzen. Der Operator soll am Ende Agenten auswählen und die ausgegebene MCP-Client-Konfiguration verwenden können. Zusätzliche manuelle Routingpflege, versteckte globale Defaults, heimliche Modellaufrufe oder nur behauptete Liefergarantien erfüllen dieses Goal nicht.

## Verifizierte Primärquellen

* [OpenClaw 2026.9.4 – Hook-Typen](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/plugins/hook-types.ts)
* [OpenClaw 2026.9.4 – Dispatch-Übernahme](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/auto-reply/reply/dispatch-from-config.reply-dispatch-hook.ts)
* [OpenClaw 2026.9.4 – Outbound SDK](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/plugin-sdk/channel-outbound.ts)
* [OpenClaw 2026.9.4 – Send-Policy](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/sessions/send-policy.ts)
* [OpenClaw 2026.9.4 – Agentenschema](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/config/types.agents.ts)
* [OpenClaw 2026.9.4 – Gateway-Plugin-Rechte](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/gateway/server-plugins.ts)
* [MCP 2025-11-25 – Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
* [OpenClaw 2026.10.6 – Vergleichsversion](https://github.com/openclaw/openclaw/tree/fe06181dc5ecc01cf8904abbfc26925925efefbc)
