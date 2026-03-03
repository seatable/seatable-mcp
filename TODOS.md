# TODOs

## API-Verhalten

- **`addRow` gibt Column-Keys statt Namen zurück**: Der `POST /rows/` Endpoint ignoriert `convert_keys` im Request-Body. Die Antwort enthält Column-Keys (`0000`, `33uo`) statt Spaltennamen (`Name`, `Age`). Workaround: nach `addRow` ein `getRow` nachschalten, um die Zeile mit Spaltennamen zu erhalten. Betrifft auch `updateRow` (nicht verifiziert).
