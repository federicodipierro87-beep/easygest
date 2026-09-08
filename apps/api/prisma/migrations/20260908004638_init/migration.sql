-- CreateEnum
CREATE TYPE "TaxRegime" AS ENUM ('FORFETTARIO', 'ORDINARIO');

-- CreateEnum
CREATE TYPE "CategoryScope" AS ENUM ('EXPENSE', 'DOCUMENT', 'BOTH');

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('CARD', 'SEPA_DIRECT_DEBIT', 'BANK_TRANSFER', 'PAYPAL', 'CASH', 'OTHER');

-- CreateEnum
CREATE TYPE "RecurrenceUnit" AS ENUM ('ONE_OFF', 'DAY', 'WEEK', 'MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED', 'ENDED');

-- CreateEnum
CREATE TYPE "RebillMode" AS ENUM ('NONE', 'PASSTHROUGH', 'MARKUP', 'FIXED');

-- CreateEnum
CREATE TYPE "OccurrenceStatus" AS ENUM ('PLANNED', 'PAID', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('INVOICE_ACTIVE', 'INVOICE_PASSIVE', 'F24', 'CONTRACT', 'COMMUNICATION', 'RECEIPT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReminderKind" AS ENUM ('EXPENSE_DUE', 'CANCELLATION_WINDOW', 'CARD_EXPIRING', 'DOCUMENT_DUE', 'DIGEST');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'IN_APP');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ipAddress" TEXT,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "taxRegime" "TaxRegime" NOT NULL DEFAULT 'FORFETTARIO',
    "substituteTaxRateBp" INTEGER NOT NULL DEFAULT 500,
    "profitabilityCoefficientBp" INTEGER NOT NULL DEFAULT 6700,
    "inpsRateBp" INTEGER NOT NULL DEFAULT 2607,
    "defaultVatRateBp" INTEGER NOT NULL DEFAULT 2200,
    "baseCurrency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Rome',
    "reminderDaysBefore" INTEGER[] DEFAULT ARRAY[30, 7, 1]::INTEGER[],
    "cancellationReminderDaysBefore" INTEGER[] DEFAULT ARRAY[60, 30, 15]::INTEGER[],
    "digestEnabled" BOOLEAN NOT NULL DEFAULT true,
    "digestDayOfWeek" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vatNumber" TEXT,
    "taxCode" TEXT,
    "sdiCode" TEXT,
    "pecEmail" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "addressLine" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "province" VARCHAR(2),
    "countryCode" VARCHAR(2) NOT NULL DEFAULT 'IT',
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vendor" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "supportEmail" TEXT,
    "accountRef" TEXT,
    "portalUrl" TEXT,
    "vatNumber" TEXT,
    "countryCode" VARCHAR(2) NOT NULL DEFAULT 'IT',
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Vendor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "CategoryScope" NOT NULL DEFAULT 'BOTH',
    "color" VARCHAR(7),
    "icon" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "PaymentMethodType" NOT NULL,
    "last4" VARCHAR(4),
    "expiryMonth" INTEGER,
    "expiryYear" INTEGER,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "vendorId" TEXT,
    "categoryId" TEXT,
    "paymentMethodId" TEXT,
    "clientId" TEXT,
    "netCents" INTEGER NOT NULL,
    "vatRateBp" INTEGER NOT NULL DEFAULT 2200,
    "grossCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "recurrenceUnit" "RecurrenceUnit" NOT NULL DEFAULT 'MONTH',
    "recurrenceInterval" INTEGER NOT NULL DEFAULT 1,
    "startDate" DATE NOT NULL,
    "endDate" DATE,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'ACTIVE',
    "autoRenew" BOOLEAN NOT NULL DEFAULT true,
    "cancellationNoticeDays" INTEGER,
    "cancelledAt" TIMESTAMP(3),
    "rebillMode" "RebillMode" NOT NULL DEFAULT 'NONE',
    "rebillMarkupBp" INTEGER,
    "rebillAmountCents" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseOccurrence" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "dueDate" DATE NOT NULL,
    "periodStart" DATE,
    "periodEnd" DATE,
    "netCents" INTEGER NOT NULL,
    "vatRateBp" INTEGER NOT NULL,
    "grossCents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "fxRate" DECIMAL(20,10),
    "baseGrossCents" INTEGER NOT NULL,
    "status" "OccurrenceStatus" NOT NULL DEFAULT 'PLANNED',
    "paidAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "documentId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxRate" (
    "id" TEXT NOT NULL,
    "base" VARCHAR(3) NOT NULL,
    "quote" VARCHAR(3) NOT NULL,
    "date" DATE NOT NULL,
    "rate" DECIMAL(20,10) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'frankfurter',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "title" TEXT NOT NULL,
    "number" TEXT,
    "issueDate" DATE NOT NULL,
    "dueDate" DATE,
    "periodStart" DATE,
    "periodEnd" DATE,
    "paidAt" TIMESTAMP(3),
    "clientId" TEXT,
    "vendorId" TEXT,
    "categoryId" TEXT,
    "netCents" INTEGER,
    "vatRateBp" INTEGER,
    "vatCents" INTEGER,
    "grossCents" INTEGER,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksumSha256" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "searchVector" tsvector,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReminderLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ReminderKind" NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "occurrenceId" TEXT,
    "referenceDate" DATE NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "succeeded" BOOLEAN NOT NULL DEFAULT true,
    "errorMessage" TEXT,

    CONSTRAINT "ReminderLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "ReminderKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_familyId_idx" ON "RefreshToken"("userId", "familyId");

-- CreateIndex
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Settings_userId_key" ON "Settings"("userId");

-- CreateIndex
CREATE INDEX "Client_userId_isActive_idx" ON "Client"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Client_userId_name_key" ON "Client"("userId", "name");

-- CreateIndex
CREATE INDEX "Vendor_userId_isActive_idx" ON "Vendor"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Vendor_userId_name_key" ON "Vendor"("userId", "name");

-- CreateIndex
CREATE INDEX "Category_userId_scope_idx" ON "Category"("userId", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "Category_userId_name_key" ON "Category"("userId", "name");

-- CreateIndex
CREATE INDEX "PaymentMethod_userId_isActive_idx" ON "PaymentMethod"("userId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentMethod_userId_label_key" ON "PaymentMethod"("userId", "label");

-- CreateIndex
CREATE INDEX "Expense_userId_status_idx" ON "Expense"("userId", "status");

-- CreateIndex
CREATE INDEX "Expense_userId_clientId_idx" ON "Expense"("userId", "clientId");

-- CreateIndex
CREATE INDEX "Expense_userId_vendorId_idx" ON "Expense"("userId", "vendorId");

-- CreateIndex
CREATE INDEX "Expense_userId_categoryId_idx" ON "Expense"("userId", "categoryId");

-- CreateIndex
CREATE INDEX "ExpenseOccurrence_userId_dueDate_idx" ON "ExpenseOccurrence"("userId", "dueDate");

-- CreateIndex
CREATE INDEX "ExpenseOccurrence_userId_status_dueDate_idx" ON "ExpenseOccurrence"("userId", "status", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseOccurrence_expenseId_dueDate_key" ON "ExpenseOccurrence"("expenseId", "dueDate");

-- CreateIndex
CREATE INDEX "FxRate_date_idx" ON "FxRate"("date");

-- CreateIndex
CREATE UNIQUE INDEX "FxRate_base_quote_date_key" ON "FxRate"("base", "quote", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Document_storageKey_key" ON "Document"("storageKey");

-- CreateIndex
CREATE INDEX "Document_userId_kind_issueDate_idx" ON "Document"("userId", "kind", "issueDate");

-- CreateIndex
CREATE INDEX "Document_userId_issueDate_idx" ON "Document"("userId", "issueDate");

-- CreateIndex
CREATE INDEX "Document_userId_clientId_idx" ON "Document"("userId", "clientId");

-- CreateIndex
CREATE INDEX "Document_userId_vendorId_idx" ON "Document"("userId", "vendorId");

-- CreateIndex
CREATE INDEX "Document_userId_checksumSha256_idx" ON "Document"("userId", "checksumSha256");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderLog_dedupeKey_key" ON "ReminderLog"("dedupeKey");

-- CreateIndex
CREATE INDEX "ReminderLog_userId_kind_referenceDate_idx" ON "ReminderLog"("userId", "kind", "referenceDate");

-- CreateIndex
CREATE INDEX "ReminderLog_occurrenceId_idx" ON "ReminderLog"("occurrenceId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paymentMethodId_fkey" FOREIGN KEY ("paymentMethodId") REFERENCES "PaymentMethod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseOccurrence" ADD CONSTRAINT "ExpenseOccurrence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseOccurrence" ADD CONSTRAINT "ExpenseOccurrence_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseOccurrence" ADD CONSTRAINT "ExpenseOccurrence_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReminderLog" ADD CONSTRAINT "ReminderLog_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "ExpenseOccurrence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ricerca full-text sui documenti
--
-- Da qui in giù è SQL scritto a mano: Prisma non sa esprimere né le colonne
-- generate né gli indici GIN, e questa parte va mantenuta manualmente anche
-- nelle migrazioni future che toccano i campi coinvolti.
--
-- La colonna è GENERATED ALWAYS ... STORED, cioè la calcola Postgres a ogni
-- scrittura. L'alternativa sarebbe un trigger o un aggiornamento applicativo:
-- entrambi si possono dimenticare, e un indice di ricerca disallineato dai dati
-- è peggio di nessun indice, perché il documento che cerchi risulta inesistente.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- I tag non compaiono qui: `array_to_string` è STABLE e non IMMUTABLE, quindi
-- Postgres la rifiuta in una colonna generata. Aggirarlo con una funzione
-- propria sarebbe stato possibile ma sbagliato: un tag è un'etichetta esatta,
-- non prosa da lemmatizzare. Si filtra per contenimento sull'array, che è più
-- preciso e ha un indice suo qui sotto.
ALTER TABLE "Document"
  DROP COLUMN "searchVector",
  ADD COLUMN "searchVector" tsvector
    GENERATED ALWAYS AS (
      -- I pesi ordinano i risultati: un termine nel titolo o nel numero conta
      -- più dello stesso termine perso in fondo alle note.
      setweight(to_tsvector('italian', coalesce("title", '')), 'A') ||
      setweight(to_tsvector('italian', coalesce("number", '')), 'A') ||
      setweight(to_tsvector('italian', coalesce("notes", '')), 'C')
    ) STORED;

CREATE INDEX "Document_searchVector_idx" ON "Document" USING GIN ("searchVector");

CREATE INDEX "Document_tags_idx" ON "Document" USING GIN ("tags");

-- Gli indici trigram servono al caso che il full-text non copre: la ricerca
-- parziale e i refusi. "fatt" non trova nulla in un tsvector, perché lì dentro
-- ci sono lemmi interi e non prefissi arbitrari.
CREATE INDEX "Document_title_trgm_idx" ON "Document" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "Document_number_trgm_idx" ON "Document" USING GIN ("number" gin_trgm_ops);
