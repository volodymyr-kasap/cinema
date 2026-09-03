CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"reservation_id" uuid NOT NULL,
	"status" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"provider_ref" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scenario" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "payments_reservation_id_unique" UNIQUE("reservation_id"),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('PENDING', 'SUCCEEDED', 'DECLINED', 'FAILED'))
);
--> statement-breakpoint
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_status_check";--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_pending_created_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_status_check" CHECK ("reservations"."status" IN ('PENDING', 'PAYMENT_PENDING', 'CONFIRMED', 'PAYMENT_FAILED', 'CANCELLED', 'EXPIRED'));