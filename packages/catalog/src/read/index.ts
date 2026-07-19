/**
 * Read-side catalog facade. Opens an EXISTING database file readonly and
 * verifies migration state via read queries only — never creates the file,
 * runs a migration, or issues any write. Only @scrapito/api and
 * @scrapito/ingest (for CLI read commands) may import this subpath.
 */
import type { Database } from "bun:sqlite";
import { CatalogDatabaseNotFoundError, CatalogMigrationsPendingError, openReaderDatabase, readerMigrationsPending } from "./db.ts";
import { CatalogQueries } from "./queries.ts";

export interface CatalogReader {
  db: Database;
  queries: CatalogQueries;
  close(): void;
}

export function openCatalogReader(path: string): CatalogReader {
  const db = openReaderDatabase(path);
  if (readerMigrationsPending(db)) {
    db.close();
    throw new CatalogMigrationsPendingError();
  }
  return {
    db,
    queries: new CatalogQueries(db),
    close: () => db.close(),
  };
}

export { openReaderDatabase, readerMigrationsPending, CatalogDatabaseNotFoundError, CatalogMigrationsPendingError } from "./db.ts";
export { CatalogQueries } from "./queries.ts";
export { encodeOfferCursor, decodeOfferCursor, fingerprintOfferSearch } from "./offer-cursor.ts";
export type { OfferCursorKey } from "./offer-cursor.ts";
export type {
  CurrentOfferRow,
  CurrentPriceDropRow,
  ImageDestinationKind,
  ImageSourceRow,
  ImageSourceTargetRow,
  PriceRow,
  PriceMovementRow,
  ProductRow,
  ProductSightingRow,
  RunRow,
  TargetCoverageRow,
  TargetIdentityRow,
  TargetMembershipRow,
  VariantImageRow,
  VariantRow,
} from "../rows.ts";
