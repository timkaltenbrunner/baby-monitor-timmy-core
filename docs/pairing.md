# Geräte-Kopplung (Pairing)

## Überblick

Zwei Geräte koppeln sich, um eine Baby-Monitor-Sitzung zu starten. Die Kopplung nutzt einen **4-stelligen Code** als Firebase-Treffpunkt und führt einen **ECDH-Schlüsselaustausch über Firebase** durch, um einen sicheren 256-Bit-Schlüssel zu erzeugen.

**Einheitlicher Ablauf (Auto + Manuell):**
1. Gerät A generiert einen 4-stelligen Code + ECDH-Schlüsselpaar
2. Code wird entweder über Nearby Connections (BLE) oder manuell übertragen
3. ECDH-Schlüsselaustausch erfolgt über Firebase Firestore
4. Visuelle Verifikation (2-stellige SAS-Zahl) auf beiden Geräten
5. Aus dem ECDH Shared Secret wird der permanente `pairingKey` abgeleitet

## Schlüsselableitungskette

```
shortCode (4 Zeichen, z.B. "K3FN")
  │
  ├─► meetingKey = SHA-256("meet:" + shortCode) → Firestore-Dokument für ECDH
  │
  └─► Firebase doc: pairing_codes/{meetingKey}
        └─ pubkeys: { <uid_A>: <pubkey_A>, <uid_B>: <pubkey_B> }

ECDH Shared Secret (32 Bytes)
  │
  ├─► pairingKey = hex(SHA-256("pair:" + sharedSecret)) → 64 Zeichen, permanent gespeichert
  ├─► SAS = (SHA-256("sas:" + sharedSecret))[0:2] % 100 → 2-stellige Verifikationszahl
  │
  └─► Session-Ableitungen:
        ├─ documentKey = SHA-256("doc:" + pairingKey) → Firestore-Routing
        ├─ channel = "sbm_" + documentKey[0:8]
        └─ encryptionKey = SHA-256("enc:" + pairingKey) → AES-256-GCM
```

## Automatische Kopplung (Nearby Connections)

### Technologie

| Plattform | Framework | Transport |
|---|---|---|
| Android | Google Nearby Connections API | Bluetooth + Wi-Fi P2P |
| iOS | Apple Multipeer Connectivity (geplant) | Bluetooth + Wi-Fi P2P |

### Ablauf

```
Gerät A                         Firebase                      Gerät B
────────                        ────────                      ────────
1. Code "K3FN" generieren
2. ECDH-Schlüsselpaar erzeugen
3. pubkey_A → pairing_codes/{meetingKey}
4. Code anzeigen + BLE-Broadcast "SBM:K3FN"
                                                              5. BLE-Discovery → Code "K3FN"
                                                              6. ECDH-Schlüsselpaar erzeugen
                                                              7. pubkey_A aus Firebase lesen
                                                              8. pubkey_B → Firebase schreiben
9. pubkey_B lesen
10. sharedSecret = ECDH(privA, pubB)                          11. sharedSecret = ECDH(privB, pubA)
12. SAS anzeigen                                               13. SAS anzeigen
    ─── Benutzer bestätigt auf beiden Geräten ───
14. pairingKey ableiten → speichern                           15. pairingKey ableiten → speichern
```

### Code-Kollision bei Auto-Discovery

Beide Geräte erzeugen eigene 4-stellige Codes. Wenn beide sich gegenseitig entdecken:
- **Alphabetisch niedrigerer Code gewinnt** → dieses Gerät ist der "Creator"
- Das andere Gerät wird zum "Joiner" und nutzt den Meeting-Point des Creators

### Protokoll-Format

BLE-Broadcast: `SBM:<4-Zeichen-Code>`, z.B. `SBM:K3FN`
- `SBM:` Präfix verhindert Kopplung mit fremden Apps
- Nur der Code wird übertragen (kein Schlüsselmaterial)
- ECDH findet über Firebase statt, nicht über BLE

## Manuelle Kopplung (Code-Fallback)

### Wann wird sie verwendet?

- Bluetooth/Wi-Fi-Berechtigungen verweigert
- Bluetooth deaktiviert
- Nutzer gibt Code des anderen Geräts direkt ein

### Ablauf

Identisch zur automatischen Kopplung, aber:
1. Gerät A zeigt seinen 4-stelligen Code an
2. Nutzer tippt den Code auf Gerät B ein
3. ECDH über Firebase (exakt gleicher Ablauf wie bei Nearby)
4. SAS-Verifikation auf beiden Geräten

## Firestore-Datenmodell

```
pairing_codes/{meetingKey}
├── createdAt: Timestamp
└── pubkeys: Map<String, String>
    ├── <uid_A>: "<base64url-ECDH-pubkey>"
    └── <uid_B>: "<base64url-ECDH-pubkey>"
```

## PairData-Modell

```dart
class PairData {
  final String pairingKey;    // 64-char hex (ECDH-abgeleitet)
  String get documentKey =>   // SHA-256("doc:" + pairingKey)
  String get channel =>       // "sbm_" + documentKey[0:8]
}
```

Wird nach erfolgreicher Kopplung in `flutter_secure_storage` (Android: EncryptedSharedPreferences) gespeichert.

## Sicherheitseigenschaften

| Aspekt | Wert |
|---|---|
| Verschlüsselungsschlüssel | 256 Bit (ECDH P-256) |
| Code-Entropie | ~20 Bit (30^4) — nur Routing, kein Schlüsselmaterial |
| MITM-Erkennung | SAS (2-stellig, 1% Fehlakzeptanz pro Versuch) |
| BLE-Broadcast | Nur 4-Zeichen-Code (kein Sicherheitswert) |
| Forward Secrecy | Ja (neues ECDH-Schlüsselpaar pro Kopplung) |
| Rückwärtskompatibilität | Alte 9-Zeichen-Codes → Re-Pairing nötig |

## Dateien

| Datei | Beschreibung |
|---|---|
| `lib/core/pairing/crypto_service.dart` | Code-Generierung, Meeting-Key, AES-256-GCM |
| `lib/core/pairing/ecdh_service.dart` | ECDH P-256: Key-Gen, Shared Secret, SAS, PairingKey |
| `lib/core/pairing/nearby_pairing_service.dart` | BLE-Discovery: Code-Broadcast und -Empfang |
| `lib/core/pairing/pairing_model.dart` | `PairData`-Klasse |
| `lib/core/storage/secure_storage.dart` | Persistenz von PairData |
| `lib/ui/screens/pairing_screen.dart` | UI: Code-Anzeige, Code-Eingabe, ECDH, SAS-Verifikation |

## Berechtigungen

**Android:**
- `ACCESS_FINE_LOCATION` — für BLE-Scan
- `BLUETOOTH`, `BLUETOOTH_ADMIN` (API ≤ 30)
- `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT`, `BLUETOOTH_SCAN` (API 31+)
- `ACCESS_WIFI_STATE`, `CHANGE_WIFI_STATE`
- `NEARBY_WIFI_DEVICES` (API 33+)

Bei Ablehnung wechselt die App zur manuellen Code-Eingabe (ECDH + SAS bleiben identisch).

## Einschränkungen

- **Emulatoren:** Nearby Connections funktioniert nicht auf Emulatoren. Test auf physischen Geräten nötig.
- **Mehrere Geräte:** Alphabetische Code-Kollisionsregel löst deterministische Creator/Joiner-Zuweisung.
- **Bereinigung:** Pairing-Codes werden nach 5 Min durch Cloud Function gelöscht.
