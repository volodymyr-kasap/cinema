# Специфікація проекту: Cinema Booking Platform

## 1. Мета проекту

Створити production-like платформу для бронювання квитків у кінотеатрі, на якій можна практично вивчити:

- висококонкурентне бронювання місць;
- distributed locking;
- transactions та consistency;
- Redis;
- RabbitMQ;
- Kafka;
- ClickHouse;
- event-driven architecture;
- idempotency;
- retries та DLQ;
- circuit breaker;
- rate limiting;
- observability;
- load testing;
- backpressure та batching.

**Головний принцип:**

Не додаємо технології заради технологій. Кожна технологія повинна вирішувати конкретну проблему системи.

## 2. Стек

**Backend**
- Node.js
- TypeScript
- NestJS

**Databases**
- PostgreSQL — транзакційні дані
- Redis — locks, cache, rate limiting
- ClickHouse — analytics/events

**Messaging**
- RabbitMQ — commands/jobs
- Kafka — event streaming

**Infrastructure**
- Docker Compose
- Prometheus
- Grafana

**Testing**
- Jest
- integration tests
- k6 для load testing


**Frontend**
- Vite + React + TypeScript + Tailwind + TanStack Query + Zustand + React Hook Form/Zod + Vitest

## 3. Основні компоненти

```
                    ┌──────────────┐
                    │   Frontend   │
                    └──────┬───────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       Business API              Analytics API
              │                         │
              ▼                         ▼
       Booking Service               Kafka
              │                         │
       ┌──────┼──────┐          ┌───────┴───────┐
       ▼      ▼      ▼          ▼               ▼
   PostgreSQL Redis RabbitMQ  Analytics       Domain
                         │       │             Events
                         ▼       ▼
                      Workers  ClickHouse
```

## 4. Domain

```
Cinema
 ├── Hall
 │    ├── Seat
 │    ├── Seat
 │    └── ...
 │
 └── Showtime
      └── Movie
```

Основні сутності:

- User
- Movie
- Cinema
- Hall
- Seat
- Showtime
- Reservation
- Booking
- Payment
- Ticket

## 5. Етап 1 — базовий backend

Створюємо NestJS застосунок.

**API**
```
GET    /movies
GET    /movies/:id

GET    /cinemas
GET    /cinemas/:id

GET    /showtimes
GET    /showtimes/:id

GET    /showtimes/:id/seats
```

Створюємо PostgreSQL schema.

Приклад:

```
movies
cinemas
halls
seats
showtimes
users
reservations
bookings
payments
tickets
```

**Результат**

Користувач може:

```
Movie
  ↓
Cinema
  ↓
Showtime
  ↓
Seat map
```

## 6. Етап 2 — базове бронювання

Додаємо:

```
POST /reservations
GET  /reservations/:id
DELETE /reservations/:id
```

Flow:

```
User
 │
 ▼
Select seats
 │
 ▼
POST /reservations
 │
 ▼
PostgreSQL
 │
 ▼
Reservation
```

Стани:

```
AVAILABLE
   ↓
HELD
   ↓
CONFIRMED
   ↓
CANCELLED
```

## 7. Етап 3 — concurrency

Це головне технічне завдання проєкту.

Перевіряємо сценарій:

```
User A ─────┐
            ├──► Seat A10
User B ─────┘
```

Обидва одночасно намагаються забронювати A10.

Вимога:

```
successful reservations = 1
```

Жодних:

```
double booking
```

## 8. Етап 4 — Redis

Redis використовуємо для тимчасового блокування місць.

```
seat:{showtimeId}:{seatId}
```

Наприклад:

```
SET seat:123:A10 reservation_456 NX EX 600
```

Де:

- NX → тільки якщо key відсутній
- EX → TTL
- 600 → 10 хвилин

Flow:

```
User
 ↓
Booking API
 ↓
Redis lock
 ↓
PostgreSQL
```

Досліджуємо:

- race conditions;
- lock expiration;
- ownership;
- idempotency;
- failure scenarios.

## 9. Етап 5 — Reservation expiration

Користувач отримує:

```
10 minutes
```

на оплату.

```
AVAILABLE
    ↓
   HELD
    ↓
PAYMENT_PENDING
```

Якщо не оплатив:

```
PAYMENT_PENDING
        ↓
      EXPIRED
        ↓
    AVAILABLE
```

Для expiration використовуємо RabbitMQ.

## 10. Етап 6 — RabbitMQ

RabbitMQ відповідає за asynchronous commands/jobs.

Наприклад:

```
booking.created
payment.requested
ticket.generate
email.send
reservation.expire
```

Архітектура:

```
                    RabbitMQ
                       │
          ┌────────────┼─────────────┐
          ▼            ▼             ▼
      Payment       Ticket        Email
       Worker       Worker        Worker
```

Вивчаємо:

- exchange;
- queue;
- routing key;
- acknowledgement;
- ack;
- nack;
- requeue;
- prefetch;
- retries;
- DLQ;
- TTL.

## 11. Етап 7 — Payment Service

Створюємо fake payment provider.

```
Booking
   ↓
Payment Service
   ↓
Fake Payment Provider
```

Сценарії:

- SUCCESS
- FAILED
- TIMEOUT
- 500

Особливо важливий кейс:

```
Payment → SUCCESS
             ↓
       response lost
```

Потрібно уникнути повторного списання.

Використовуємо:

```
Idempotency-Key
```

## 12. Етап 8 — Idempotency

API:

```
POST /bookings

Idempotency-Key: abc-123
```

Якщо клієнт надіслав запит п'ять разів:

```
POST
POST
POST
POST
POST
```

результат:

```
1 booking
1 payment
1 ticket
```

а не п'ять.

Idempotency застосовуємо до:

- booking;
- payment;
- ticket generation;
- event processing.

## 13. Етап 9 — Kafka

Kafka використовуємо не для звичайних jobs, а для подій.

Domain events:

```
booking.created
booking.confirmed
booking.cancelled

payment.completed
payment.failed

ticket.issued

reservation.expired
```

Архітектура:

```
Booking Service
      │
      ▼
    Kafka
      │
 ┌────┼────────────┐
 ▼    ▼            ▼
Audit Analytics  Notifications
```

## 14. Етап 10 — Frontend Event Tracking

Frontend надсилає product events:

```
movie_viewed
cinema_viewed
showtime_viewed
seat_map_opened
seat_selected
seat_unselected
checkout_started
payment_page_opened
```

Наприклад:

```json
{
  "eventId": "uuid",
  "eventName": "seat_selected",
  "timestamp": "...",
  "sessionId": "session-123",
  "userId": "user-42",
  "properties": {
    "movieId": 10,
    "showtimeId": 100,
    "seatId": "A10"
  }
}
```

## 15. Етап 11 — Analytics Pipeline

Frontend:

```
Frontend
   ↓
Analytics API
   ↓
Kafka
   ↓
Analytics Consumer
   ↓
ClickHouse
```

Не робимо:

```
Frontend
   ↓
PostgreSQL
```

для кожної event.

## 16. Етап 12 — ClickHouse

Створюємо events table.

Основні поля:

```
event_id
event_name
timestamp
user_id
session_id
platform
movie_id
cinema_id
showtime_id
seat_id
properties
```

ClickHouse використовується як:

```
analytical read store
```

PostgreSQL залишається:

```
transactional source of truth
```

## 17. Етап 13 — Batch ingestion

Consumer не повинен робити:

```
event
 ↓
INSERT
```

на кожну подію.

Робимо:

```
Kafka
 ↓
Consumer
 ↓
buffer
 ↓
1,000 events
 ↓
batch INSERT
 ↓
ClickHouse
```

Досліджуємо:

- batch size;
- flush interval;
- throughput;
- memory usage;
- backpressure.

## 18. Етап 14 — Analytics

Створюємо dashboard:

**Movie views**
```
Avatar       124,500
Batman        98,200
Dune          87,100
```

**Conversion funnel**
```
movie_viewed
      ↓
showtime_viewed
      ↓
seat_selected
      ↓
checkout_started
      ↓
payment_completed
      ↓
booking_confirmed
```

**Metrics**
- Views
- Seat selections
- Checkout starts
- Successful bookings
- Conversion rate
- Revenue

## 19. Етап 15 — Retry + DLQ

Наприклад Payment Worker:

```
Payment
   ↓
500
   ↓
Retry #1
   ↓
500
   ↓
Retry #2
   ↓
500
   ↓
Retry #3
   ↓
DLQ
```

Використовуємо:

```
exponential backoff
+
jitter
```

## 20. Етап 16 — Circuit Breaker

Якщо payment provider постійно падає:

```
CLOSED
   ↓
errors
   ↓
OPEN
   ↓
timeout
   ↓
HALF-OPEN
   ↓
success
   ↓
CLOSED
```

Не продовжуємо безглуздо надсилати запити до несправного downstream.

## 21. Етап 17 — Rate Limiting

Особливо для:

```
POST /reservations
POST /payments
POST /analytics/events
```

Наприклад:

```
100 requests / second / user
```

При перевищенні:

```
429 Too Many Requests
```

Redis використовуємо як distributed rate limiter.

## 22. Етап 18 — Observability

Додаємо:

```
Prometheus
     ↓
Grafana
```

Метрики:

- HTTP requests/sec
- HTTP latency
- HTTP errors
- RabbitMQ queue depth
- RabbitMQ processing latency
- Kafka consumer lag
- ClickHouse insert latency
- Booking success rate
- Payment failure rate
- Reservation expiration rate
- Redis lock failures

## 23. Етап 19 — Distributed tracing

Додаємо correlation ID:

```
requestId
   ↓
HTTP request
   ↓
booking
   ↓
RabbitMQ message
   ↓
payment
   ↓
Kafka event
   ↓
analytics
```

Наприклад:

```
traceId = 7f8a...
```

за яким можна знайти весь lifecycle booking.

## 24. Етап 20 — Load Testing

Використовуємо k6.

**Scenario 1 — normal**
```
100 RPS
```

**Scenario 2 — stress**
```
100
 ↓
500
 ↓
1,000
 ↓
2,000 RPS
```

**Scenario 3 — cinema premiere**
```
10,000 concurrent users
```

Усі намагаються купити місця одного популярного сеансу.

## 25. Головний performance experiment

Створити:

```
Cinema
 └── Hall
      └── 1,000 seats
```

І:

```
10,000 concurrent users
```

Результат повинен бути:

```
10,000 attempts
        ↓
1,000 successful seat reservations
        ↓
0 double bookings
```

Після цього порівняти:

```
DB locking
vs
Redis locking
```

і виміряти:

- throughput
- p95
- p99
- error rate
- lock contention

## 26. Фінальна архітектура

```
                         ┌──────────────┐
                         │   Frontend   │
                         └──────┬───────┘
                                │
                 ┌──────────────┴──────────────┐
                 │                             │
                 ▼                             ▼
          Business API                  Analytics API
                 │                             │
                 ▼                             ▼
          Booking Service                    Kafka
                 │                       ┌─────┴─────┐
       ┌─────────┼─────────┐             │           │
       ▼         ▼         ▼             ▼           ▼
 PostgreSQL    Redis    RabbitMQ     Analytics     Domain
       │                   │          Consumer      Events
       │              ┌────┼────┐         │
       │              ▼    ▼    ▼         ▼
       │           Payment Ticket Email ClickHouse
       │
       ▼
  Source of Truth
```

## 27. Порядок розробки

Я б не намагався зробити все одразу.

```
Phase 1
├── NestJS
├── PostgreSQL
├── Movies
├── Cinemas
├── Halls
├── Seats
└── Showtimes

Phase 2
├── Reservations
├── Bookings
└── Transactions

Phase 3
├── Redis
├── Seat locking
└── Concurrency tests

Phase 4
├── RabbitMQ
├── Workers
├── Retry
└── DLQ

Phase 5
├── Payment
├── Idempotency
└── Circuit breaker

Phase 6
├── Kafka
├── Domain events
└── Consumer groups

Phase 7
├── Frontend tracking
├── Analytics API
└── Event schema

Phase 8
├── ClickHouse
├── Kafka → ClickHouse
└── Batch ingestion

Phase 9
├── Analytics
├── Funnels
└── Dashboard

Phase 10
├── Prometheus
├── Grafana
└── Correlation IDs

Phase 11
├── k6
├── Stress testing
└── Premiere scenario

Phase 12
└── Architecture optimization
```

## 🎯 Definition of Done

Проєкт можна вважати завершеним, коли ти можеш показати: 10,000 користувачів одночасно намагаються купити квитки на один сеанс, система не допускає double booking, payment обробляється асинхронно через RabbitMQ, domain events йдуть через Kafka, frontend events потрапляють через Kafka в ClickHouse, а вся система спостережувана через Prometheus/Grafana.

І найголовніше — ти зможеш обґрунтувати кожне архітектурне рішення, а не просто сказати: "я використав Redis, RabbitMQ, Kafka і ClickHouse".