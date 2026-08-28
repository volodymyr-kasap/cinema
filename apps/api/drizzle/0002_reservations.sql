CREATE TABLE "reservation_seats" (
	"reservation_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"showtime_id" uuid NOT NULL,
	"price_cents" integer NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "reservation_seats_reservation_id_seat_id_pk" PRIMARY KEY("reservation_id","seat_id")
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"showtime_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"status" text NOT NULL,
	"total_price_cents" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "reservations_status_check" CHECK ("reservations"."status" IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'))
);
--> statement-breakpoint
ALTER TABLE "reservation_seats" ADD CONSTRAINT "reservation_seats_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_seats" ADD CONSTRAINT "reservation_seats_seat_id_seats_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."seats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservation_seats" ADD CONSTRAINT "reservation_seats_showtime_id_showtimes_id_fk" FOREIGN KEY ("showtime_id") REFERENCES "public"."showtimes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_showtime_id_showtimes_id_fk" FOREIGN KEY ("showtime_id") REFERENCES "public"."showtimes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reservation_seats_active_uq" ON "reservation_seats" USING btree ("showtime_id","seat_id") WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX "reservations_session_created_idx" ON "reservations" USING btree ("session_id","created_at" desc,"id" desc);