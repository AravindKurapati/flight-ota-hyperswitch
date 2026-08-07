CREATE TYPE "public"."booking_state" AS ENUM('QUOTED', 'PAYMENT_FAILED', 'AUTHORIZED', 'TICKETING', 'TICKETED', 'VOIDED', 'REFUNDED', 'PARTIALLY_REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('in_flight', 'complete');--> statement-breakpoint
CREATE TYPE "public"."payment_kind" AS ENUM('flight', 'protection', 'ancillary');--> statement-breakpoint
CREATE TABLE "booking_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "booking_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"booking_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"pnr" text NOT NULL,
	"itinerary_id" text NOT NULL,
	"passengers" jsonb NOT NULL,
	"currency" char(3) DEFAULT 'USD' NOT NULL,
	"amount_minor" bigint NOT NULL,
	"state" "booking_state" DEFAULT 'QUOTED' NOT NULL,
	"customer_id" text,
	"payment_method_id" text,
	"ticket_number" text,
	"void_deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_pnr_unique" UNIQUE("pnr"),
	CONSTRAINT "bookings_amount_positive" CHECK ("bookings"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"key" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"response" jsonb,
	"status" "idempotency_status" DEFAULT 'in_flight' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"kind" "payment_kind" NOT NULL,
	"hs_payment_id" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"capture_method" text NOT NULL,
	"connector" text,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_hs_payment_id_unique" UNIQUE("hs_payment_id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_minor" > 0),
	CONSTRAINT "hs_payment_id_is_30_chars" CHECK (length("payments"."hs_payment_id") = 30)
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"hs_refund_id" text,
	"amount_minor" bigint NOT NULL,
	"reason" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_hs_refund_id_unique" UNIQUE("hs_refund_id"),
	CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_minor" > 0)
);
--> statement-breakpoint
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_events_booking_id_idx" ON "booking_events" USING btree ("booking_id","created_at");--> statement-breakpoint
CREATE INDEX "bookings_state_idx" ON "bookings" USING btree ("state");--> statement-breakpoint
CREATE INDEX "bookings_created_at_idx" ON "bookings" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idempotency_created_at_idx" ON "idempotency_records" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_one_per_kind_idx" ON "payments" USING btree ("booking_id","kind") WHERE kind IN ('flight', 'protection');--> statement-breakpoint
CREATE INDEX "payments_booking_id_idx" ON "payments" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refunds_one_per_reason_idx" ON "refunds" USING btree ("payment_id","reason");--> statement-breakpoint
CREATE INDEX "refunds_payment_id_idx" ON "refunds" USING btree ("payment_id");