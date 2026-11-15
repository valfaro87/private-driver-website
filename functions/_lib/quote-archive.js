export async function quoteArchiveExists(db) {
  return Boolean(await db.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'owner_quote_archives'"
  ).first());
}

export async function excludeArchivedQuotes(db) {
  return await quoteArchiveExists(db)
    ? "AND NOT EXISTS (SELECT 1 FROM owner_quote_archives a WHERE a.quote_reference = q.reference)"
    : "";
}

export async function setQuoteArchived(db, reference, archived) {
  if (archived) {
    // Existing deployments can use the archive without a separate schema update.
    await db.prepare(`
      CREATE TABLE IF NOT EXISTS owner_quote_archives (
        quote_reference TEXT PRIMARY KEY NOT NULL REFERENCES ride_quotes(reference) ON DELETE CASCADE,
        archived_at TEXT NOT NULL
      )
    `).run();
    await db.prepare(`
      INSERT OR IGNORE INTO owner_quote_archives (quote_reference, archived_at)
      SELECT reference, ? FROM ride_quotes WHERE reference = ?
    `).bind(new Date().toISOString(), reference).run();
  } else if (await quoteArchiveExists(db)) {
    await db.prepare("DELETE FROM owner_quote_archives WHERE quote_reference = ?").bind(reference).run();
  }
}
