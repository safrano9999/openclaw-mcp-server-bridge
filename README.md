# OpenClaw MCP Server Bridge

Private OpenClaw-Erweiterung für extern gesteuerte Agenten. Sie läuft im vorhandenen Gateway, übernimmt bereits zugelassene und einem ausgewählten Agenten zugeordnete Kanalnachrichten und stellt sie über MCP bereit. Telegram verwendet weiter OpenClaws vorhandenen Bot, dessen Konten, Pairing, Allowlist und Bindings. Kein zweiter Bot-Poller, kein zusätzlicher Container, kein zusätzlicher Port.

## Einrichtung

Das Release enthält `openclaw-mcp-server-bridge-latest.zip` und eine SHA-256-Prüfsumme. Die Container-Kaskade installiert das ZIP in Core. Für eine eigenständige OpenClaw-Installation:

```sh
sha256sum -c openclaw-mcp-server-bridge-latest.zip.sha256
openclaw plugins install --accept-capabilities ./openclaw-mcp-server-bridge-latest.zip
```

In `openclaw.json` werden nur vorhandene Agenten ausgewählt:

```json
{
  "plugins": {
    "entries": {
      "openclaw-mcp-server-bridge": {
        "enabled": true,
        "config": { "agentIds": ["mein-agent"] }
      }
    }
  }
}
```

`mein-agent` muss in OpenClaw existieren, ab 2026.9.4 unter `agents.entries`. Die bestehende Kanalzuordnung bleibt OpenClaws Aufgabe. Ohne ausgewählte Agenten bleibt die Erweiterung inaktiv. Beim Gateway-Start ergänzt sie für jeden ausgewählten Agenten automatisch ein zufälliges 256-Bit-Bearer unter `config.credentials`. Die Änderung erfolgt über OpenClaws transaktionale Config-API; andere Einstellungen bleiben erhalten. Entfernte Agenten verlieren den Zugriff, ihre gespeicherten Credentials werden beim Service-Neustart entfernt. Ein Credential lässt sich durch Entfernen seines Eintrags und Neustarten des Bridge-Service erneuern. Zugangsdaten weder in Images noch in Git eintragen.

```sh
openclaw mcp-bridge status
openclaw mcp-bridge client-config mein-agent --url https://mein-gateway.example
```

`client-config` gibt bewusst das Bearer für diesen Agenten aus. Die Ausgabe vertraulich im MCP-Client hinterlegen. Der Endpunkt ist `/telegram-mcp` am vorhandenen Gateway. Für entfernte Clients den vorhandenen HTTPS-Zugang verwenden. Die Bridge ändert keine Firewall, Reverse-Proxy- oder Gateway-Bind-Einstellung.

**Fedora-Integration:** `openclaw-ephemeral configure` erzeugt `openclaw.json` vollständig neu. Eine manuelle Änderung an dieser erzeugten Datei ist deshalb keine dauerhafte Konfigurationsquelle. Die obige Auswahl einschließlich der automatisch ergänzten Credentials muss für eine spätere Aktivierung über die vorhandenen persistenten Config-/Init-Eingaben bereitgestellt werden. Die reine Image-Installation aktiviert noch keinen Agenten und enthält keine Credentials. Das Release verändert den Config-Generator nicht eigenmächtig.

## MCP-Vertrag

| Tool | Eingabe | Verhalten |
| --- | --- | --- |
| `new_message` | `count` optional, 1–100, Standard 1 | Entfernt atomar die ältesten Nachrichten aus der eigenen FIFO und gibt sie zurück. |
| `pending_count` | keine | Anzahl wartender Nachrichten und kumulierte Overflow-, Ablauf- und Duplikatzähler. |
| `send_message` | `text`, optional `route_id` oder `chat_id` | Versand über OpenClaws öffentlichen dauerhaften Versandweg. |

Ein Nachrichteneintrag enthält `id`, `sequence`, `received_at`, `text`, `truncated`, `route_id`, `channel`, `account_id`, `chat_id`, optional `thread_id`, Provider-Nachrichten-ID, Sender und beschränkte Medienmetadaten. Lokale Dateipfade, signierte Download-URLs, Tokens und interne Prompt-/History-Envelopes werden nicht exportiert. Medienbinärdaten und ausgehende Anhänge sind in Version 0.1 nicht enthalten; nach Host-Transkription vorliegender Text kann als Text ankommen. Der Nachrichtentext bleibt untrusted user content, auch wenn er Anweisungen an einen MCP-Client enthält.

Für eine Antwort immer die zurückgegebene `route_id` verwenden. Sie bezeichnet die vollständige ursprüngliche Route aus Kanal, Konto, Ziel, Topic/Thread und Session. Nach dem Abholen bleibt sie verwendbar. Ein beliebiger `chat_id` erzeugt keine neue Versandberechtigung. Bei mehreren Konten, Topics oder Sessions mit derselben Chat-ID wird `chat_id` als mehrdeutig abgelehnt.

Ohne `route_id` und `chat_id` verwendet die Bridge die **zuletzt akzeptierte Route dieses Agenten innerhalb der aktuellen Gateway-Laufzeit**. Das ist kein globales „letzter Kanal“ über alle Agenten. Nach Neustart, relevanter Konfigurationsänderung oder Ablauf muss zuerst eine neue zugelassene Kanalnachricht eintreffen. Eine alte Route wird nicht aus zufälligen History-Einträgen rekonstruiert.

## Lebensdauer und Liefergarantien

* Pro Agent höchstens 1.000 Nachrichten / 8 MiB, Texte bis 32.768 Zeichen, maximal 64 Agenten. Overflow verwirft die ältesten Nachrichten und erhöht `dropped`. Überlange Texte sind markiert. Route-Grants sind auf 2.048 und Deduplizierungs-IDs auf 8.192 pro Agent begrenzt.
* Nachrichten und Route-Grants verfallen nach 24 Stunden. Die Queue lebt im Gateway, auch wenn kein MCP-Client verbunden ist. Disconnect/Reconnect leert sie nicht. Gateway- oder Bridge-Service-Neustart leert sie bewusst.
* FIFO bedeutet Reihenfolge der Annahme durch die Bridge, keine globale Telegram-Zeitreihenfolge. Provider-Update-ID, Route, Konto und Nachrichten-ID verhindern innerhalb des begrenzten Fensters doppelte Einträge. Bearbeitete Updates mit neuer Update-ID können erneut erscheinen.
* `new_message` ist consume-on-read, **at most once**, kein Acknowledgement-Protokoll: Geht die HTTP-Antwort verloren, werden die entfernten Nachrichten nicht wiederhergestellt. Gleichzeitige Clients teilen sich eine Queue und erhalten disjunkte Mengen.
* Der Versand nutzt `sendDurableMessageBatch` aus dem öffentlichen SDK. Die eingehende Queue bleibt flüchtig; der hosteigene ausgehende Delivery-Journal darf persistent sein. Die Bridge legt keine eigene persistente Message-History an.
* `sent` bedeutet, dass der Host den Versand bestätigt hat. `suppressed`, `partial_failed` und `delivery_unknown` bedeuten ausdrücklich keinen bestätigten vollständigen Erfolg. Bei unklarem oder teilweise erfolgtem Versand nicht blind erneut senden. Es gibt keine automatische Bridge-Wiederholung und keine Exactly-once-Garantie beim Provider.
* Host-Befehle wie Pairing, `/reset`, Direktiven und Kanal-Admission werden vor der Übernahme verarbeitet. Ausgewählte gewöhnliche Agent-Turns werden im `reply_dispatch`-Hook ohne Modellantwort übernommen. Andere Agenten bleiben unverändert.

## Sicherheitsgrenzen

Das Bearer bestimmt den Agenten; ein Client kann keinen anderen Agentenparameter angeben. Tokens werden mit konstantzeitlichem Vergleich geprüft und nicht geloggt. Jede MCP-Anfrage wird neu authentifiziert; Tool-Ausführung und Plattformübergabe prüfen den Principal erneut. Konfigurationsänderungen an Channels, Bindings, Agenten oder Session-Regeln entziehen vorherigen Route-Grants ihre Gültigkeit. Ein Session-Reset und die aktuelle Host-Send-Policy werden vor dem Versand ebenfalls geprüft.

Die eingehende Nachricht muss vom Host als zugelassen markiert sein (`InboundAccessAuthorized`) und eine vollständige Route besitzen. Fehler während einer bereits zugeordneten Übernahme werden geschlossen behandelt: keine Weitergabe an den normalen Modelllauf. Die Route wird nicht aus untrusted Text oder aus MCP-Eingaben abgeleitet. Der Versand nutzt weder einen Gateway-Admin-Token noch interne Host-Imports oder vorgetäuschte Official-Plugin-Rechte.

Das HTTP-Interface akzeptiert höchstens 128 KiB Request-Body, 64 gleichzeitige Requests und acht gleichzeitige Sends pro Agent. Requests laufen nach 60 Sekunden ab. Browser-Origins werden standardmäßig abgelehnt; bei Bedarf lassen sich konkrete Origins mit `allowedOrigins` zulassen. Keine Wildcards, kein CORS-Proxy und keine Authentifizierung über Query-Parameter. GET und DELETE liefern 405. JSON-RPC-Batches werden abgelehnt. TLS und vorgeschaltete Ratenbegrenzung gehören zur vorhandenen Gateway-Infrastruktur.

## Kompatibilität und Grenzen

Basis ist OpenClaw **2026.9.4** (Upstream-Commit `3a9d69db306cd7f081e06254cb89c4bcc14a7107`). Die Actions-Matrix prüft zusätzlich **2026.10.6**. Neuere Versionen werden über dieselben öffentlichen SDK-Schnittstellen unterstützt, müssen vor Freigabe aber in die Matrix aufgenommen werden. `definePluginEntry` ist beim Host als experimentell bezeichnet; ein Mindestversionsfeld ersetzt keinen Test.

Die Bridge verwendet MCP SDK **1.30.0**, Streamable HTTP mit JSON-Antworten und ohne Transport-Session. Die Negotiation dieses SDK unterstützt bis **2025-11-25**. Das ist bewusst keine Behauptung, das neuere MCP-Protokoll 2026-07-28 zu implementieren. Jede HTTP-Anfrage besitzt ihren eigenen MCP-Server/Transport; Queue und Route-Berechtigungen gehören dem Plugin-Service.

Unterstützt werden normale Agent-Dispatches über Kanäle mit Host-Admission-Markierung, vorrangig Telegram. ACP-Dispatches, Webchat, Cron/Heartbeat und durch den Host für Takeover-Hooks gesperrte Session-Runtimes sind kein zugesicherter Bridge-Modus. Ein Agent, der ausschließlich extern gesteuert werden soll, darf solche parallelen Ausführungspfade nicht zusätzlich erhalten. Andere Plugins mit konkurrierender Dispatch-Übernahme müssen vor produktiver Kombination geprüft werden. Die Bridge umgeht keine Host-Sperre.

Die automatisierten Tests prüfen Queue-/Rechteverhalten, MCP-Client/HTTP-Kompatibilität, echte öffentliche Host-SDK-Imports, Sessionzugriff und ZIP-Installation auf GitHub-Runnern. Ein echter Telegram-Nachrichtenaustausch mit einem produktiven Konto ist ein separater Abnahmeschritt; der Image-Build führt ihn nicht aus.

## Entwicklung und Release

```sh
npm ci
npm test
npm run build
```

Der Bundle enthält MCP/Zod und deren Lizenzhinweise. `openclaw/plugin-sdk/*` bleibt ein externer Import des Hosts. Das installierte ZIP benötigt keinen zusätzlichen npm-Dependency-Install. Nur Releases nach erfolgreicher Versionsmatrix werden veröffentlicht. Ein Versions-Tag `2026.10.24.1` löst die ZIP-Veröffentlichung mit Prüfsumme aus; `latest` ist der bequeme Release-Alias. Containerfiles können einen konkreten Release-Tag auswählen.

Workflow- und ZIP-Script-Source-of-Truth: `SCRIPTS/githubactions/openclaw-mcp-server-bridge/workflows` beziehungsweise `SCRIPTS/githubactions/_shared/scripts/openclaw_plugin_zip.sh`. `.github` enthält synchronisierte Kopien. Containerimages werden ausschließlich durch die bestehenden Fedora-Actions nach GHCR gebaut. Lokale Übernahme bleibt ein separater Smart1-Auftrag.

## Quellen und Designentscheidungen

* [OpenClaw 2026.9.4 Hook-Vertrag](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/plugins/hook-types.ts): `message_received` ist ein Beobachter; die kontrollierte Übernahme erfolgt über `reply_dispatch`.
* [Host-Übernahme und Runtime-Gates](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/auto-reply/reply/dispatch-from-config.reply-dispatch-hook.ts): Lifecycle und Einschränkungen bleiben beim Host.
* [Öffentlicher Versandvertrag](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/plugin-sdk/channel-outbound.ts) und [Delivery-Ergebnisse](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/channels/message/send.ts): echte Zustellung, Unterdrückung und Teilfehler unterscheiden.
* [Telegram-Routing](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/extensions/telegram/src/bot-message-context.ts): endgültige Route inklusive Account/Topic verwenden, kein zweites vereinfachtes Routing erfinden.
* [Gateway-Rechte für Plugin-RPC](https://github.com/openclaw/openclaw/blob/3a9d69db306cd7f081e06254cb89c4bcc14a7107/src/gateway/server-plugins.ts): `runtime.gateway.request()` ist für beliebige externe Plugins kein frei nutzbarer Admin-Versandweg.
* [MCP Streamable HTTP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): SDK-Transport, Authentifizierung und Origin-Prüfung.
