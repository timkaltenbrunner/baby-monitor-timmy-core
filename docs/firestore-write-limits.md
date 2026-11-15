# Firestore write limits

The rules cap the quality event tail at 20 entries, matching the shared mobile
and web client code, and cap an encrypted ICE media ID at 1,024 characters.
The existing ICE candidate limit stays below 8,192 characters. Unrelated
updates can still touch session documents with older telemetry shapes.
