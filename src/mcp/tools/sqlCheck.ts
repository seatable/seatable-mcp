import { makeError } from '../../errors.js'

/**
 * Static checks for SeaTable SQL. SeaTable implements a restricted SQL dialect;
 * models tend to write MySQL/PostgreSQL and then burn several round trips on
 * errors. Constructs SeaTable never accepts are rejected before the request,
 * and function names known to fail get a hint appended to SeaTable's error.
 */

export type StatementKind = 'select' | 'update' | 'delete' | 'insert' | 'other'

/**
 * Replace string literals, quoted identifiers and comments with neutral
 * placeholders so keyword checks don't fire on `Join Date` or 'union station'.
 */
export function stripLiterals(sql: string): string {
    let out = ''
    let i = 0
    while (i < sql.length) {
        const ch = sql[i]
        const next = sql[i + 1]
        if (ch === '-' && next === '-') {
            const end = sql.indexOf('\n', i)
            i = end === -1 ? sql.length : end
            out += ' '
            continue
        }
        if (ch === '/' && next === '*') {
            const end = sql.indexOf('*/', i + 2)
            i = end === -1 ? sql.length : end + 2
            out += ' '
            continue
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            let j = i + 1
            while (j < sql.length) {
                if (sql[j] === '\\' && ch !== '`') { j += 2; continue }
                if (sql[j] === ch) {
                    if (sql[j + 1] === ch) { j += 2; continue }
                    break
                }
                j++
            }
            out += ch === '`' ? '`x`' : "''"
            i = j + 1
            continue
        }
        out += ch
        i++
    }
    return out
}

export function statementKind(sql: string): StatementKind {
    const match = /^[\s(]*([a-z]+)/i.exec(stripLiterals(sql))
    const word = match?.[1].toLowerCase()
    return word === 'select' || word === 'update' || word === 'delete' || word === 'insert' ? word : 'other'
}

const UNSUPPORTED_CONSTRUCTS: Array<{ pattern: RegExp; message: string }> = [
    {
        pattern: /^\s*with\b/i,
        message: 'Common table expressions (WITH ... AS) are not supported. Run the inner query on its own first and use its results in a second query.',
    },
    {
        pattern: /\(\s*select\b/i,
        message: 'Subqueries are not supported. Run the inner SELECT on its own first, then pass its values into the outer query, e.g. WHERE `Col` IN (?, ?, ?) with parameters.',
    },
    {
        pattern: /\b(union|intersect|except)\b/i,
        message: 'UNION, INTERSECT and EXCEPT are not supported. Run one query per part and combine the results yourself.',
    },
    {
        pattern: /\bjoin\b/i,
        message: 'The JOIN keyword is not supported. Use an implicit inner join: FROM `T1`, `T2` WHERE `T1`.`col` = `T2`.`col`. Outer joins are not available; query the tables separately instead.',
    },
    {
        pattern: /\bover\s*\(/i,
        message: 'Window functions (OVER ...) are not supported. Use GROUP BY for aggregates, or compute rankings from the returned rows.',
    },
    {
        pattern: /;\s*\S/,
        message: 'Only one statement per call is supported. Send each statement in its own call.',
    },
]

/**
 * Throw ERR_VALIDATION if the statement uses a construct SeaTable SQL never
 * accepts. These are grammar limits, so rejecting them cannot block a query
 * that would have worked.
 */
export function assertSupportedSql(sql: string): void {
    const stripped = stripLiterals(sql)
    const problems = UNSUPPORTED_CONSTRUCTS.filter(c => c.pattern.test(stripped)).map(c => c.message)
    if (problems.length) {
        throw makeError('ERR_VALIDATION', `SeaTable SQL does not support this query. ${problems.join(' ')}`)
    }
}

const FUNCTION_HINTS: Array<{ pattern: RegExp; hint: string }> = [
    { pattern: /\b(substr|substring)\s*\(/i, hint: 'use mid(str, pos, len) instead of SUBSTR/SUBSTRING' },
    { pattern: /\b(concat|concat_ws)\s*\(/i, hint: 'use concatenate(str1, str2, ...) instead of CONCAT' },
    { pattern: /\b(length|char_length)\s*\(/i, hint: 'use len(str) instead of LENGTH' },
    { pattern: /\brepeat\s*\(/i, hint: 'use rept(str, n) instead of REPEAT' },
    { pattern: /\b(locate|instr)\s*\(/i, hint: 'use find(substr, str) or search(substr, str) instead of LOCATE/INSTR' },
    { pattern: /\bucase\s*\(/i, hint: 'use upper(str) instead of UCASE' },
    { pattern: /\blcase\s*\(/i, hint: 'use lower(str) instead of LCASE' },
    { pattern: /\bformat\s*\(/i, hint: 'use text(num, format) instead of FORMAT' },
    { pattern: /\b(curdate\s*\(|current_date\b)/i, hint: 'use today() instead of CURDATE/CURRENT_DATE' },
    { pattern: /\b(date_add|date_sub)\s*\(/i, hint: 'use dateAdd(date, n, "unit") instead of DATE_ADD/DATE_SUB' },
    { pattern: /\b(datediff|timestampdiff)\s*\(/i, hint: 'use dateDif(d1, d2, unit) instead of DATEDIFF/TIMESTAMPDIFF' },
    { pattern: /\bextract\s*\(/i, hint: 'use year(date), month(date), day(date) instead of EXTRACT' },
    { pattern: /\bdayofweek\s*\(/i, hint: 'use weekday(date, weekStart) instead of DAYOFWEEK' },
    { pattern: /\bweek\s*\(/i, hint: 'use weeknum(date, return_type) instead of WEEK' },
    { pattern: /\blast_day\s*\(/i, hint: 'use eomonth(date, 0) instead of LAST_DAY' },
    { pattern: /\bceil\s*\(/i, hint: 'use ceiling(n) instead of CEIL' },
    { pattern: /\bpow\s*\(/i, hint: 'use power(a, b) instead of POW' },
    { pattern: /\blog10\s*\(/i, hint: 'use lg(n) instead of LOG10' },
    { pattern: /\blog2\s*\(/i, hint: 'use log(n, 2) instead of LOG2' },
    { pattern: /\btruncate\s*\(/i, hint: 'use rounddown(n, d) instead of TRUNCATE' },
    { pattern: /\bcase\s+when\b/i, hint: 'use if(cond, a, b) or ifs(cond1, val1, cond2, val2, ...) instead of CASE WHEN' },
    {
        pattern: /\b(cast|convert|greatest|least|coalesce|ifnull|nullif|rand|group_concat|lpad|rpad|reverse|dayname|monthname|str_to_date)\s*\(/i,
        hint: 'CAST, CONVERT, GREATEST, LEAST, COALESCE, IFNULL, NULLIF, RAND, GROUP_CONCAT, LPAD, RPAD, REVERSE, DAYNAME, MONTHNAME and STR_TO_DATE do not exist in SeaTable SQL',
    },
]

/**
 * Hints for MySQL function names in a statement that SeaTable rejected. Only
 * used after a failure: some names may be valid in a future SeaTable release,
 * so they never block a request on their own.
 */
export function functionHints(sql: string): string[] {
    const stripped = stripLiterals(sql)
    return FUNCTION_HINTS.filter(h => h.pattern.test(stripped)).map(h => h.hint)
}

/** Run a statement and append function-name hints to SeaTable's error message. */
export async function withSqlHints<T>(sql: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run()
    } catch (err) {
        const hints = functionHints(sql)
        if (hints.length && err instanceof Error) {
            err.message = `${err.message} Hint: ${hints.join('; ')}.`
        }
        throw err
    }
}

export const SQL_SYNTAX_RULES = `Syntax rules:
- Quote table/column names with backticks: \`Table Name\`, \`Column Name\` (not double quotes). Required for names with spaces, hyphens, or names matching function names.
- Empty strings are treated as NULL. Use IS NULL / IS NOT NULL instead of = "".
- Use ILIKE for case-insensitive matching (LIKE is case-sensitive).
- For multi-select/collaborator columns use: HAS ANY OF, HAS ALL OF, HAS NONE OF, IS EXACTLY (values in parentheses like IN).
- Not supported: subqueries, WITH (CTE), UNION/INTERSECT/EXCEPT, the JOIN keyword, window functions (OVER), multiple statements. Such queries are rejected before they run. Split them into several simple queries instead.
- SeaTable function names differ from MySQL (e.g. mid, concatenate, len, dateAdd, if/ifs); see the server instructions.`
