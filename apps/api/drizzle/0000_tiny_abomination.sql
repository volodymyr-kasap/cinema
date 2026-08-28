CREATE TABLE "cinemas" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"address" text NOT NULL,
	"timezone" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "halls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"cinema_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "movies" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"poster_url" text NOT NULL,
	"release_date" date NOT NULL,
	"rating" real NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seat_categories" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"surcharge_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seats" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"hall_id" uuid NOT NULL,
	"row_label" text NOT NULL,
	"seat_number" integer NOT NULL,
	"category_code" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "showtimes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"movie_id" uuid NOT NULL,
	"hall_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"base_price_cents" integer NOT NULL,
	"language" text NOT NULL,
	"format" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "halls" ADD CONSTRAINT "halls_cinema_id_cinemas_id_fk" FOREIGN KEY ("cinema_id") REFERENCES "public"."cinemas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_hall_id_halls_id_fk" FOREIGN KEY ("hall_id") REFERENCES "public"."halls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seats" ADD CONSTRAINT "seats_category_code_seat_categories_code_fk" FOREIGN KEY ("category_code") REFERENCES "public"."seat_categories"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showtimes" ADD CONSTRAINT "showtimes_movie_id_movies_id_fk" FOREIGN KEY ("movie_id") REFERENCES "public"."movies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "showtimes" ADD CONSTRAINT "showtimes_hall_id_halls_id_fk" FOREIGN KEY ("hall_id") REFERENCES "public"."halls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "halls_cinema_idx" ON "halls" USING btree ("cinema_id");--> statement-breakpoint
CREATE UNIQUE INDEX "halls_cinema_name_uq" ON "halls" USING btree ("cinema_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "seats_hall_row_number_uq" ON "seats" USING btree ("hall_id","row_label","seat_number");--> statement-breakpoint
CREATE INDEX "seats_hall_idx" ON "seats" USING btree ("hall_id");--> statement-breakpoint
CREATE INDEX "showtimes_movie_starts_idx" ON "showtimes" USING btree ("movie_id","starts_at");--> statement-breakpoint
CREATE INDEX "showtimes_hall_starts_idx" ON "showtimes" USING btree ("hall_id","starts_at");