# Testing the SQL tools with a model

Unit tests can't show whether a model actually uses the tools well. Run this series after changing tool descriptions, the server instructions or the SQL checks, and ideally with a small model too: a strong model hides gaps in the instructions that a weaker one runs into.

Check two things for each prompt: whether the answer is right, and which calls it took. A wrong answer can come without any error, for example from a result cut at 100 rows.

## Test data

Create a base with two tables. Import the CSV files, then set the column types.

**Kunden:** `Umsatz` number, `Status` single select (`aktiv`, `inaktiv`), `Kunde seit` date.

```csv
Name,Ort,Umsatz,Status,Kunde seit
Müller GmbH,Mainz,12000,aktiv,2021-03-01
Schmidt AG,Wiesbaden,4500,inaktiv,2019-07-15
Weber KG,Mainz,8800,aktiv,2023-11-20
Fischer OHG,Frankfurt,300,aktiv,2024-01-05
Becker & Söhne,Frankfurt,15200,aktiv,2020-05-12
Hoffmann IT,Darmstadt,2100,aktiv,2022-09-30
Klein Logistik,Mainz,6700,inaktiv,2018-02-14
Wagner Bau,Wiesbaden,950,aktiv,2025-04-01
```

**Bestellungen:** `Kunde` link to `Kunden`, `Betrag` number, `Datum` date. Use a real link column: it is what makes prompts 1 and 2 hard. SeaTable then also creates a link column `Bestellungen` in `Kunden`.

```csv
Nr,Kunde,Betrag,Datum
B-1001,Müller GmbH,500,2026-07-03
B-1002,Müller GmbH,700,2026-07-18
B-1003,Weber KG,250,2026-07-22
B-1004,Becker & Söhne,3200,2026-08-05
B-1005,Becker & Söhne,1800,2026-08-19
B-1006,Hoffmann IT,420,2026-08-27
B-1007,Müller GmbH,950,2026-09-02
B-1008,Weber KG,1300,2026-09-15
B-1009,Becker & Söhne,640,2026-10-08
B-1010,Hoffmann IT,2100,2026-10-21
```

## Prompts

The prompts are in German on purpose, to match the data. Run prompt 7 last, since it changes data, and set both customers back to `aktiv` afterwards.

| #   | Prompt                                                                             | Tempts the model to                                 | Good path                                                  | Right answer                                                                                                       |
| --- | ---------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Welche Kunden haben noch keine Bestellung?                                         | subquery, `LEFT JOIN`                               | one `query_sql`: ``WHERE `Bestellungen` IS NULL``          | Schmidt AG, Fischer OHG, Klein Logistik, Wagner Bau                                                                |
| 2   | Zeig mir pro Kunde die Summe aller Bestellungen und den Ort.                       | `JOIN`, a join on the link column (returns nothing) | `` GROUP BY `Kunde` ``, then a second query for the cities | Becker & Söhne 5.640 (Frankfurt), Hoffmann IT 2.520 (Darmstadt), Müller GmbH 2.150 (Mainz), Weber KG 1.550 (Mainz) |
| 3   | Welcher Kunde hat die größte Einzelbestellung?                                     | `WHERE x = (SELECT MAX…)`                           | `ORDER BY … DESC LIMIT 1`                                  | Becker & Söhne, B-1004, 3.200                                                                                      |
| 4   | Teile die Kunden nach Umsatz ein: ab 10.000 groß, ab 2.000 mittel, darunter klein. | `CASE WHEN`                                         | `ifs()`, or read the rows and classify them                | groß: Müller, Becker · mittel: Weber, Klein, Schmidt, Hoffmann · klein: Wagner, Fischer                            |
| 5   | Zeig die ersten drei Buchstaben jedes Namens zusammen mit dem Ort in einer Spalte. | `SUBSTRING`, `CONCAT`                               | `concatenate(mid(…), …)`                                   | e.g. "Mül Mainz", "Bec Frankfurt"                                                                                  |
| 6   | Wie viele Bestellungen gab es pro Monat?                                           | `DATE_FORMAT`, `EXTRACT`                            | `month()`/`year()` with `GROUP BY`                         | July 3, August 3, September 2, October 2                                                                           |
| 7   | Setze alle Kunden aus Frankfurt auf inaktiv.                                       | sending the `UPDATE` to `query_sql`                 | `execute_sql` with `UPDATE … WHERE`                        | 2 rows: Fischer OHG, Becker & Söhne                                                                                |

## What to watch

Follow the server log while testing:

```bash
docker logs -f --since 1m seatable-mcp 2>&1 | grep --line-buffered -E '"tool":|SQL statement failed' \
  | jq -rc '[.time[11:19], .tool, .msg, (.reasons // empty | join(",")), (.sql_shape // empty)] | join("  ")'
```

- **Ideally no rejection at all**: the model follows the description and asks simple queries.
- **After a failed call**, the next one should restructure the statement, not repeat it with small changes.
- **A row count of exactly 100** without a `notice` in the result would be a bug in the truncation notice.

For the cause of a failure, see README, "SQL failure log".
