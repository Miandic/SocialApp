# Diffract — Architecture & Developer Documentation

## Содержание

1. [Общее описание проекта](#1-общее-описание-проекта)
2. [Что реализовано сейчас](#2-что-реализовано-сейчас)
3. [Что ещё не реализовано (план)](#3-что-ещё-не-реализовано-план)
4. [Временные костыли](#4-временные-костыли)
5. [Инфраструктура](#5-инфраструктура)
6. [Backend — структура](#6-backend--структура)
7. [Backend — шаблоны и паттерны](#7-backend--шаблоны-и-паттерны)
8. [Backend — глобальные взаимосвязи](#8-backend--глобальные-взаимосвязи)
9. [Frontend — структура](#9-frontend--структура)
10. [Frontend — паттерны](#10-frontend--паттерны)
11. [API Reference](#11-api-reference)
12. [База данных — схема](#12-база-данных--схема)
13. [Быстрый старт](#13-быстрый-старт)
14. [Как добавить новый модуль](#14-как-добавить-новый-модуль)
15. [План реализации E2E шифрования](#15-план-реализации-e2e-шифрования)
16. [Следующие итерации (приоритизированный список)](#16-следующие-итерации-приоритизированный-список)

---

## 1. Общее описание проекта

**Diffract** — социальная сеть с интегрированным мессенджером, ориентированная на СНГ-рынок.

| Параметр | Значение |
|---|---|
| Домен | diffract.ru |
| Стадия | MVP в разработке |
| Бэкенд | Rust, Axum 0.8, модульный монолит |
| Фронтенд | Vanilla JS + Vite (временный, под замену) |
| БД | PostgreSQL 16 |
| Кеш / PubSub | Redis 7 |
| Хранилище медиа | MinIO (S3-совместимый) |
| Поиск | Elasticsearch 8 |
| Шифрование сообщений | Signal-подобный протокол (X3DH + pre-keys) |

**Архитектурное решение:** модульный монолит — все модули живут в одном процессе и бинарнике, но изолированы по директориям и слоям. При необходимости каждый модуль можно вынести в отдельный микросервис, не переписывая логику.

---

## 2. Что реализовано сейчас

### Бэкенд
- ✅ **Auth** — регистрация, логин, JWT access + refresh токены с ротацией, logout, `/me`
- ✅ **Users** — профили, follow/unfollow, списки подписчиков/подписок, счётчики
- ✅ **Posts** — создание/удаление постов, лайки, хронологическая лента (свои посты + подписки)
- ✅ **Messenger** — WebSocket real-time чат, DM и групповые чаты, история сообщений, typing indicators, read receipts
- ✅ **E2E ключи** — таблицы и API для Signal-подобного обмена ключами (identity key, signed pre-key, one-time pre-keys)
- ✅ **Notifications** — хранение, чтение, mark read, unread count
- ✅ **Media** — multipart upload в MinIO с валидацией типов и размера (10MB)
- ✅ **Middleware** — JWT-экстракторы `AuthUser` и `OptionalAuthUser`, единый тип ошибок

### Фронтенд (тестовый)
- ✅ Регистрация и логин
- ✅ Лента постов с лайками
- ✅ Профиль пользователя
- ✅ Чат-интерфейс: список чатов, окно переписки, создание DM
- ✅ Real-time через WebSocket (typing, новые сообщения)
- ✅ Auto-refresh JWT токенов

---

## 3. Что ещё не реализовано (план)

### Функциональность
- ❌ **Поиск** — Elasticsearch подключён к инфре, но поисковые эндпоинты и индексация не написаны
- ❌ **Алгоритмическая лента** — сейчас чистая хронология; нужен скоринг по лайкам, репостам, весу подписок
- ❌ **Репосты** — поле `repost_count` в БД есть, логика не написана
- ❌ **Медиа в постах** — поле `media_urls` есть, upload-эндпоинт есть, но интеграция между ними (прикрепить к посту) не сделана
- ❌ **Групповые чаты через UI** — API поддерживает, фронт умеет только DM
- ❌ **Push-уведомления** — нотификации создаются в БД, но не вызываются из других модулей (например, при лайке поста)
- ❌ **Верификация email** — поле `is_verified` есть, логика не написана
- ❌ **Аватары** — upload через `/api/media/upload` есть, но привязка к профилю (обновление `avatar_url`) через UI не сделана
- ❌ **Блокировки** — таблицы нет, логика нет
- ❌ **Rate limiting** — зависимость `tower-http` с feature `limit` добавлена, но middleware не подключено
- ❌ **Commentsна посты**

### Инфраструктура
- ❌ Деплой (намеренно отложен)
- ❌ Мониторинг / метрики
- ❌ CI/CD

---

## 4. Временные костыли

### 🔴 Крупные — нужно заменить перед релизом

#### 1. Сообщения в чате — plaintext вместо E2E шифрования

**Где:** `frontend/src/main.js`, функция `openChat()`

```js
// КОСТЫЛЬ: текст уходит как plaintext в поле encrypted_content
sendWs({
  type: "send_message",
  chat_id: chatId,
  encrypted_content: text,   // <-- должен быть реальный шифротекст
  nonce: "test-nonce",       // <-- должен быть реальный nonce
});
```

**Проблема:** бэкенд хранит то, что пришло, не проверяя шифрование. Сервер видит содержимое сообщений.

**Как заменить:** реализовать клиентский E2E на основе [Signal Protocol](https://signal.org/docs/):
1. При логине — генерировать ключи (identity key + pre-keys) с помощью `libsodium-wrappers` или `@privacyresearch/libsignal-protocol-typescript`
2. Отправлять key bundle через WS-команду `upload_pre_keys`
3. Перед первым сообщением запрашивать key bundle получателя (`request_key_bundle`)
4. Шифровать через X3DH + Double Ratchet, отправлять base64-encoded ciphertext

Бэкенд уже полностью готов к этому: хранит ключи, отдаёт one-time pre-keys, хранит `encrypted_content` и `nonce` как opaque строки.

---

#### 2. WebSocket-аутентификация через query param

**Где:** `backend/src/modules/messenger/ws.rs`, `frontend/src/api.js`

```
ws://host/api/messenger/ws?token=eyJhbGc...
```

**Проблема:** токен попадает в server logs, proxy logs, browser history. Это нормально для тестирования, неприемлемо в продакшене.

**Как заменить:** после установки WS-соединения клиент первым сообщением отправляет токен (`{"type":"auth","token":"..."`}), сервер валидирует и только потом начинает обрабатывать остальные команды. Само соединение при неудаче закрывается с кодом 4001.

---

### 🟡 Средние — желательно исправить в ближайших итерациях

#### 3. Уведомления не создаются автоматически

**Где:** `backend/src/modules/notifications/repo.rs` — метод `create()` объявлен, но нигде не вызывается.

**Что должно быть:** при лайке поста → уведомить автора; при follow → уведомить пользователя; при упоминании — уведомить упомянутого.

**Как исправить:** в `PostsRepo::like()` и `UsersRepo::follow()` добавить вызов `NotificationsRepo::create()`. Либо ввести event bus внутри монолита (например, `tokio::sync::broadcast`).

#### 4. N+1 запросы в некоторых хендлерах

**Где:** `messenger/handlers.rs` — `build_chat_response()` делает отдельный SQL-запрос на каждого участника чата; `posts/handlers.rs` — `build_post_response()` делает отдельный запрос для автора каждого поста в ленте.

**Как исправить:** использовать JOIN в SQL или батчевые запросы через `WHERE id = ANY($1)`.

---

### 🟢 Мелкие — технический долг

#### 5. CORS открыт для всех

**Где:** `backend/src/main.rs`

```rust
CorsLayer::new().allow_origin(Any)  // разрешено всем
```

**Как исправить:** ограничить до `diffract.ru` и `localhost` для локальной разработки через конфиг.

#### 6. JWT подписан HS256 (симметричный)

Сейчас JWT подписывается одним секретным ключом. При масштабировании на несколько инстансов ключ нужно везде разделять. Достаточно для монолита, но при переходе на микросервисы стоит рассмотреть RS256 (асимметричный).

---

## 5. Инфраструктура

### Файлы конфигурации

| Файл | Назначение |
|---|---|
| `docker-compose.yml` | Поднимает все сервисы для локальной разработки |
| `.env` | Переменные окружения для Docker Compose (корень) |
| `backend/.env` | Переменные окружения для бэкенда (грузится через `dotenvy`) |
| `.gitignore` | Исключает `target/`, `node_modules/`, `.env`, `.claude` |

### Docker-сервисы

| Контейнер | Образ | Порты | Данные |
|---|---|---|---|
| `diffract-postgres` | postgres:16-alpine | 5432 | volume `postgres_data` |
| `diffract-redis` | redis:7-alpine | 6379 | volume `redis_data` |
| `diffract-minio` | minio/minio | 9000 (API), 9001 (UI) | volume `minio_data` |
| `diffract-elasticsearch` | elasticsearch:8.13.0 | 9200 | volume `elastic_data` |

> **Сброс данных:** `docker-compose down -v` — удаляет все volumes и пересоздаёт БД с нуля.

### Переменные окружения (backend/.env)

```
DATABASE_URL      — строка подключения к PostgreSQL
REDIS_URL         — строка подключения к Redis
S3_ENDPOINT       — URL MinIO (http://localhost:9000)
S3_BUCKET         — имя бакета (diffract-media)
S3_ACCESS_KEY     — ключ доступа MinIO
S3_SECRET_KEY     — секрет MinIO
ELASTICSEARCH_URL — URL Elasticsearch
JWT_SECRET        — секрет для подписи JWT
JWT_ACCESS_TTL_SECS  — TTL access токена (900 = 15 минут)
JWT_REFRESH_TTL_SECS — TTL refresh токена (2592000 = 30 дней)
SERVER_HOST       — хост сервера (0.0.0.0)
SERVER_PORT       — порт сервера (3000)
RUST_LOG          — уровень логов (diffract=debug,tower_http=debug)
```

---

## 6. Backend — структура

```
backend/
├── Cargo.toml                    # зависимости проекта
├── .env                          # переменные окружения
├── migrations/
│   └── 0001_init.sql             # вся схема БД (единственная миграция)
└── src/
    ├── main.rs                   # точка входа, сборка роутера, запуск сервера
    ├── config.rs                 # Config struct — парсит все env переменные
    ├── db.rs                     # создание PgPool и Redis ConnectionManager
    ├── errors.rs                 # AppError enum + IntoResponse + AppResult<T>
    ├── state.rs                  # AppState — разделяемое состояние между хендлерами
    ├── middleware/
    │   ├── mod.rs                # pub mod auth
    │   └── auth.rs               # AuthUser и OptionalAuthUser — Axum экстракторы
    └── modules/
        ├── mod.rs                # pub mod для всех модулей
        ├── auth/
        │   ├── mod.rs            # router() — регистрация маршрутов
        │   ├── models.rs         # Request/Response structs + DB row structs
        │   ├── repo.rs           # SQL-запросы к БД
        │   ├── service.rs        # бизнес-логика (хэширование, JWT генерация)
        │   └── handlers.rs       # Axum хендлеры (register, login, refresh, logout, me)
        ├── users/
        │   ├── mod.rs
        │   ├── models.rs
        │   ├── repo.rs
        │   └── handlers.rs
        ├── posts/
        │   ├── mod.rs
        │   ├── models.rs
        │   ├── repo.rs
        │   └── handlers.rs
        ├── messenger/
        │   ├── mod.rs
        │   ├── models.rs         # WsClientMessage, WsServerMessage, REST models, DB rows
        │   ├── repo.rs           # SQL-запросы (чаты, сообщения, ключи)
        │   ├── handlers.rs       # REST хендлеры (create_chat, list_chats, get_messages)
        │   ├── hub.rs            # ConnectionHub — in-memory WebSocket роутинг
        │   └── ws.rs             # WebSocket upgrade handler + обработка WS-команд
        ├── notifications/
        │   ├── mod.rs
        │   ├── models.rs
        │   ├── repo.rs
        │   └── handlers.rs
        └── media/
            ├── mod.rs
            ├── models.rs         # UploadResponse
            ├── service.rs        # S3Client создание + upload + ensure_bucket
            └── handlers.rs       # multipart upload хендлер
```

### Описание файлов корневого уровня

#### `main.rs`
Точка входа. Порядок инициализации:
1. `dotenvy::dotenv()` — загрузка `.env`
2. `tracing_subscriber` — настройка логов
3. `Config::from_env()` — парсинг конфига
4. `create_pg_pool()` + `create_redis()` — подключения к БД
5. `sqlx::migrate!()` — автоматический прогон миграций при старте
6. `MediaService::create_s3_client()` + `ensure_bucket()` — инициализация S3
7. `ConnectionHub::new()` — создание WS-хаба
8. Сборка `AppState` и `Router` через `.nest()`
9. `axum::serve()` — запуск сервера

#### `config.rs`
`Config` — простой struct с полями под каждую переменную. Загружается один раз при старте и кладётся в `AppState`. Паника при отсутствии обязательных переменных (fail-fast на старте, а не в рантайме).

#### `db.rs`
Две функции: `create_pg_pool()` (PgPoolOptions, max 20 соединений) и `create_redis()` (ConnectionManager для async Redis). Паника если не удалось подключиться — при старте лучше упасть явно.

#### `errors.rs`
`AppError` — единый enum ошибок для всего приложения. Реализует `IntoResponse`, поэтому хендлеры могут возвращать `AppResult<T>` = `Result<T, AppError>` напрямую — Axum сам сконвертирует ошибку в JSON-ответ с нужным HTTP статусом. Внутренние ошибки (Database, Internal) логируются и не раскрывают детали клиенту.

#### `state.rs`
`AppState` — клонируемая структура, которая передаётся во все хендлеры через Axum State:

```rust
pub struct AppState {
    pub db: PgPool,                          // пул PostgreSQL соединений
    pub redis: redis::aio::ConnectionManager, // пул Redis соединений
    pub config: Config,                       // конфиг приложения
    pub s3_client: S3Client,                  // клиент MinIO/S3
    pub hub: ConnectionHub,                   // WebSocket connection hub
}
```

Реализованы `FromRef<AppState>` для `PgPool` и `Config`, что позволяет Axum-экстракторам получать их напрямую из state.

#### `middleware/auth.rs`
Два Axum-экстрактора:

- **`AuthUser`** — обязательная аутентификация. Читает `Authorization: Bearer <token>`, валидирует JWT, возвращает `AppError::Unauthorized` если токен отсутствует или невалиден. Используется в любом защищённом хендлере.

- **`OptionalAuthUser(Option<AuthUser>)`** — опциональная аутентификация. Если заголовка нет — возвращает `None`. Используется там, где поведение зависит от того, залогинен ли пользователь (например, поле `is_following` в профиле).

### Описание модулей

#### `modules/auth/`

| Файл | Содержимое |
|---|---|
| `models.rs` | `RegisterRequest` (с валидацией через `#[derive(Validate)]`), `LoginRequest`, `RefreshRequest`, `AuthResponse`, `UserInfo`, `UserRow` (DB), `RefreshTokenRow` (DB) |
| `repo.rs` | `AuthRepo` — `create_user`, `find_by_login`, `find_by_id`, `store_refresh_token`, `find_refresh_token`, `delete_refresh_token`, `delete_user_refresh_tokens` |
| `service.rs` | `AuthService` — `register`, `login`, `refresh`, `logout`. Приватные хелперы: `hash_password` (Argon2), `verify_password`, `generate_token_pair`, `hash_token` (SHA-256 для хранения refresh токена) |
| `handlers.rs` | 5 хендлеров: `register`, `login`, `refresh`, `logout`, `me` |

**Логика refresh токенов:** токен не хранится в БД напрямую — хранится его SHA-256 хэш. При refresh старый токен удаляется, создаётся новый (rotation). Это защищает от компрометации БД.

#### `modules/users/`

| Файл | Содержимое |
|---|---|
| `models.rs` | `UpdateProfileRequest`, `ProfileResponse`, `UserListItem`, `PaginationParams` |
| `repo.rs` | `UsersRepo` — `find_by_username`, `update_profile`, `follow`, `unfollow`, `is_following`, `followers_count`, `following_count`, `get_followers`, `get_following` |
| `handlers.rs` | `get_profile` (с `OptionalAuthUser` для поля `is_following`), `update_profile`, `follow`, `unfollow`, `get_followers`, `get_following` |

#### `modules/posts/`

| Файл | Содержимое |
|---|---|
| `models.rs` | `CreatePostRequest`, `PostResponse`, `PostAuthor`, `PostRow` (DB), `FeedParams` |
| `repo.rs` | `PostsRepo` — `create`, `find_by_id`, `delete`, `like`, `unlike`, `is_liked`, `feed` (cursor-based по `created_at`), `user_posts` |
| `handlers.rs` | `create_post`, `get_post`, `delete_post`, `like_post`, `unlike_post`, `feed`. Хелпер `build_post_response` собирает полный ответ с автором и флагом `is_liked` |

**Лента (`feed`):** возвращает посты авторов на которых подписан пользователь + свои посты, отсортированные по `created_at DESC`. Пагинация cursor-based: передаётся `before` (datetime), возвращается следующая порция до этой метки.

#### `modules/messenger/`

Самый сложный модуль. Имеет два транспорта: REST (история, создание чатов) и WebSocket (real-time).

| Файл | Содержимое |
|---|---|
| `models.rs` | `WsClientMessage` (enum с тегом `type`), `WsServerMessage` (enum с тегом `type`), REST-модели, DB-строки |
| `repo.rs` | `MessengerRepo` — методы для чатов, участников, сообщений, E2E ключей |
| `handlers.rs` | `create_chat` (находит существующий DM перед созданием), `list_chats`, `get_messages` |
| `hub.rs` | `ConnectionHub` — хранит `HashMap<Uuid, Vec<Sender>>` (user_id → список WS-соединений). Методы: `register`, `unregister`, `send_to_user`, `send_to_users`, `is_online` |
| `ws.rs` | `ws_handler` — upgrade с JWT из query param `?token=`. После апгрейда запускает два параллельных tokio-таска: один читает из hub и шлёт в WS, другой читает из WS и диспетчеризует команды |

**WebSocket-команды клиент → сервер:**

| `type` | Параметры | Действие |
|---|---|---|
| `send_message` | `chat_id`, `encrypted_content`, `nonce`, `message_type?` | Сохраняет в БД, рассылает всем участникам чата |
| `typing` | `chat_id` | Рассылает другим участникам |
| `mark_read` | `chat_id`, `message_id` | Рассылает другим участникам |
| `upload_pre_keys` | `identity_key`, `signed_pre_key`, `signed_pre_key_signature`, `one_time_pre_keys[]` | Сохраняет key bundle в БД |
| `request_key_bundle` | `user_id` | Возвращает key bundle + один OTP-ключ (помечает использованным) |

#### `modules/notifications/`

| Файл | Содержимое |
|---|---|
| `models.rs` | `NotificationType` enum, `NotificationResponse`, `NotificationRow` (DB), `NotificationsQuery` |
| `repo.rs` | `NotificationsRepo` — `create`, `get_for_user`, `mark_read`, `mark_all_read`, `unread_count` |
| `handlers.rs` | `list`, `mark_read`, `mark_all_read`, `unread_count` |

#### `modules/media/`

| Файл | Содержимое |
|---|---|
| `models.rs` | `UploadResponse { url, key }` |
| `service.rs` | `MediaService::create_s3_client()` — создаёт S3Client с `force_path_style(true)` (обязательно для MinIO). `upload()` — генерирует уникальный ключ `uploads/{uuid}/{uuid}.ext`, загружает через `put_object`. `ensure_bucket()` — создаёт бакет если не существует |
| `handlers.rs` | `upload` — multipart хендлер. Проверяет MIME-тип (jpeg/png/gif/webp/mp4/webm) и размер (max 10MB). Возвращает массив `UploadResponse` |

---

## 7. Backend — шаблоны и паттерны

### Структура модуля (повторяется в каждом модуле)

```
modules/<name>/
├── mod.rs       — router() + pub mod декларации
├── models.rs    — все типы данных модуля
├── repo.rs      — SQL-запросы (unit struct + impl)
├── service.rs   — бизнес-логика (опционально, если логика сложная)
└── handlers.rs  — Axum хендлеры
```

### Шаблон хендлера с аутентификацией

```rust
pub async fn my_handler(
    State(state): State<AppState>,  // доступ к БД, конфигу, S3, хабу
    user: AuthUser,                 // обязательный JWT (401 если нет)
    Json(req): Json<MyRequest>,     // тело запроса
) -> AppResult<Json<MyResponse>> {
    req.validate()
        .map_err(|e| AppError::Validation(e.to_string()))?;

    let result = MyRepo::do_something(&state.db, user.user_id, &req).await?;
    Ok(Json(result))
}
```

### Шаблон хендлера с опциональной аутентификацией

```rust
pub async fn my_handler(
    State(state): State<AppState>,
    OptionalAuthUser(auth): OptionalAuthUser,  // None если не залогинен
    Path(id): Path<Uuid>,
) -> AppResult<Json<MyResponse>> {
    let viewer_id = auth.map(|u| u.user_id);
    // ...
}
```

### Шаблон repo-метода

```rust
pub struct MyRepo;  // unit struct — все методы статические

impl MyRepo {
    pub async fn find(pool: &PgPool, id: Uuid) -> AppResult<Option<MyRow>> {
        let row = sqlx::query_as::<_, MyRow>("SELECT * FROM my_table WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await?;  // ? конвертирует sqlx::Error -> AppError::Database
        Ok(row)
    }
}
```

### Шаблон cursor-based пагинации (посты, сообщения)

```rust
// Запрос принимает `before: Option<DateTime<Utc>>` и `limit`
// Первая страница: before = None → берём NOW()
// Следующая страница: before = last_item.created_at
SELECT * FROM posts
WHERE created_at < $1   -- $1 = before (или NOW())
ORDER BY created_at DESC
LIMIT $2
```

### Обработка конфликтов в repo

```rust
.map_err(|e| match &e {
    sqlx::Error::Database(db_err)
        if db_err.constraint() == Some("users_username_key") =>
        AppError::Conflict("Username already taken".into()),
    _ => AppError::Database(e),
})
```

### Транзакция (пример — лайк поста)

```rust
let mut tx = pool.begin().await?;
// ... несколько операций через &mut *tx
tx.commit().await?;
```

### Шаблон router в mod.rs

```rust
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/path", get(handlers::my_get))
        .route("/path", post(handlers::my_post))
        .route("/path/{id}", delete(handlers::my_delete))
}
```

---

## 8. Backend — глобальные взаимосвязи

```
main.rs
  │
  ├── Config (из .env)
  │
  ├── AppState ──────────────────────────────────────────────────────┐
  │   ├── db: PgPool          ← все Repo-методы принимают &PgPool   │
  │   ├── redis: ConnMgr      ← пока не используется в логике        │
  │   ├── config: Config      ← JWT секрет, бакет, TTL              │
  │   ├── s3_client           ← MediaService::upload()               │
  │   └── hub: ConnectionHub  ← ws.rs: send_to_users()              │
  │                                                                   │
  └── Router                                                         │
      ├── /api/auth      → modules::auth::router()                   │
      ├── /api/users     → modules::users::router()                  │
      ├── /api/posts     → modules::posts::router()                  │
      ├── /api/messenger → modules::messenger::router()              │
      │     ├── REST: handlers.rs                                     │
      │     └── WS:   ws.rs ──→ hub.rs ──→ WsServerMessage          │
      ├── /api/notifications → modules::notifications::router()      │
      └── /api/media     → modules::media::router()                  │
                                                                      │
middleware/auth.rs ← AuthUser, OptionalAuthUser (используются в handlers ─┘
errors.rs          ← AppError, AppResult<T> (используются везде)
```

**Поток запроса:**
```
HTTP Request
  → Tower middleware (CORS, трейсинг)
  → Axum роутер → нужный хендлер
  → Экстракторы (State, AuthUser, Json, Path, Query)
  → Handler → вызов Service или Repo
  → Repo → sqlx → PostgreSQL
  → AppResult<Json<T>> или AppError
  → IntoResponse → HTTP Response
```

**Поток WebSocket-сообщения:**
```
Browser WS → ws_handler (upgrade + JWT валидация)
  → handle_socket (два tokio::spawn)
  → Recv task: handle_client_message()
      → MessengerRepo::store_message() → PostgreSQL
      → MessengerRepo::get_chat_members() → PostgreSQL
      → hub.send_to_users([member_ids], WsServerMessage)
  → Send task: hub_rx.recv() → ws sender
      → Browser WS (все вкладки пользователя)
```

---

## 9. Frontend — структура

```
frontend/
├── package.json      # зависимости: только vite
├── vite.config.js    # proxy /api/* → localhost:3000
├── index.html        # единственная HTML-страница, подключает main.js и style.css
└── src/
    ├── main.js       # весь JS-код: роутер, рендеринг страниц, WS-логика
    ├── api.js        # API-клиент: все fetch-вызовы к бэкенду
    └── style.css     # все стили
```

### `vite.config.js`
Настроен proxy: все запросы `/api/*` перенаправляются на `http://localhost:3000`, WS `/api/messenger/ws` — на `ws://localhost:3000`. Это позволяет фронту работать на порту 5173 без CORS-проблем в разработке.

### `api.js`
Центральный модуль для всех HTTP-запросов. Экспортирует именованные объекты по доменам:

```
auth      — register, login, logout, me, setTokens, clearTokens, getToken, isLoggedIn
users     — profile, updateProfile, follow, unfollow, followers, following
posts     — create, get, delete, like, unlike, feed
messenger — createChat, listChats, getMessages, connectWs
notifications — list, markRead, markAllRead, unreadCount
```

**Автоматический refresh:** если запрос вернул 401, `request()` автоматически пробует `tryRefresh()`. Если refresh успешен — повторяет оригинальный запрос. Если нет — очищает токены и диспатчит событие `auth:logout`.

**Хранение токенов:** `localStorage` (`access_token`, `refresh_token`).

### `main.js`

Организован как минимальный SPA без фреймворка:

**Глобальное состояние:**
```js
let currentUser = null;   // кешированный результат /auth/me
let ws = null;            // текущее WS-соединение
let currentChatId = null; // открытый чат
```

**Роутер:**
```js
const routes = { login, register, feed, profile, chats };
function navigate(page, params = {}) { ... }
```

**WS-менеджмент:** `connectWs()` / `disconnectWs()` / `sendWs()`. После дисконнекта — автоматический реконнект через 3 секунды (пока пользователь залогинен).

**Страницы:**
| Функция | Что рендерит |
|---|---|
| `renderLogin()` | Форма входа |
| `renderRegister()` | Форма регистрации |
| `renderFeed()` | Форма поста + лента + лайки |
| `renderProfile()` | Профиль текущего пользователя |
| `renderChats()` | Двухколоночный layout: список чатов + окно переписки |

**Чат-функции:**
| Функция | Назначение |
|---|---|
| `loadChatList()` | Загружает и рендерит список чатов в сайдбаре |
| `openChat(chatId)` | Открывает чат: загружает историю, вешает обработчики отправки и typing |
| `renderMessage(msg)` | HTML одного сообщения (своё/чужое по `sender_id === currentUser.id`) |
| `appendMessage(msg)` | Добавляет сообщение в конец при получении через WS |
| `showNewChatDialog()` | Модальное окно для создания DM по username |
| `handleWsMessage(msg)` | Диспетчер входящих WS-сообщений по полю `type` |

### `style.css`

CSS-переменные в `:root`:
```css
--bg, --surface, --border   — фон и поверхности
--text, --text-muted         — цвета текста
--accent, --accent-hover     — основной цвет (#6366f1 — indigo)
--danger, --success          — семантические цвета
--radius                     — радиус скругления (8px)
```

**Ключевые классы:**
| Класс | Назначение |
|---|---|
| `.card` | Карточка с `var(--surface)` фоном и бордером |
| `.btn`, `.btn-sm`, `.btn-outline`, `.btn-danger` | Кнопки |
| `.form-group` | Обёртка поля формы (label + input) |
| `.error-msg` | Красный текст ошибки |
| `.chat-layout` | CSS Grid: 280px сайдбар + 1fr область сообщений |
| `.chat-item`, `.chat-item-active` | Элемент списка чатов |
| `.message`, `.message-mine`, `.message-theirs` | Обёртка сообщения |
| `.bubble-mine`, `.bubble-theirs` | Бабл сообщения (фиолетовый / тёмный) |
| `.new-chat-dialog`, `.new-chat-overlay` | Модальное окно |

---

## 10. Frontend — паттерны

### Шаблон страницы

```js
function renderMyPage(container) {
  container.innerHTML = `...HTML...`;

  // Навешиваем обработчики после рендера
  document.getElementById("my-btn").onclick = async () => {
    try {
      const data = await someApiCall();
      // обновить UI
    } catch (err) {
      document.getElementById("error").textContent = err.message || "Error";
    }
  };
}
```

### Шаблон API-вызова

```js
try {
  const result = await api.someMethod(payload);
  // успех
} catch (err) {
  // err — это объект { error: string, message: string } от бэкенда
  showError(err.message || "Something went wrong");
}
```

### Шаблон отправки WS-сообщения

```js
sendWs({
  type: "send_message",    // совпадает с WsClientMessage variant в snake_case
  chat_id: "uuid",
  encrypted_content: "...",
  nonce: "...",
});
```

### Экранирование HTML

Всегда используй `escapeHtml()` перед вставкой пользовательских данных в innerHTML:

```js
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
```

---

## 11. API Reference

Все эндпоинты с префиксом `/api`. Авторизованные требуют заголовок `Authorization: Bearer <access_token>`.

### Auth

| Метод | Путь | Auth | Тело | Ответ |
|---|---|---|---|---|
| POST | `/auth/register` | — | `{username, email, password, display_name?}` | `AuthResponse` |
| POST | `/auth/login` | — | `{login, password}` | `AuthResponse` |
| POST | `/auth/refresh` | — | `{refresh_token}` | `AuthResponse` |
| POST | `/auth/logout` | ✓ | — | `{message}` |
| GET | `/auth/me` | ✓ | — | `UserInfo` |

`AuthResponse`: `{access_token, refresh_token, user: UserInfo}`

### Users

| Метод | Путь | Auth | Тело | Ответ |
|---|---|---|---|---|
| GET | `/users/{username}` | optional | — | `ProfileResponse` |
| PATCH | `/users/profile` | ✓ | `{display_name?, bio?, avatar_url?}` | `ProfileResponse` |
| POST | `/users/{username}/follow` | ✓ | — | `{message}` |
| DELETE | `/users/{username}/follow` | ✓ | — | `{message}` |
| GET | `/users/{username}/followers` | — | `?offset&limit` | `UserListItem[]` |
| GET | `/users/{username}/following` | — | `?offset&limit` | `UserListItem[]` |

### Posts

| Метод | Путь | Auth | Тело | Ответ |
|---|---|---|---|---|
| POST | `/posts` | ✓ | `{content, media_urls?}` | `PostResponse` |
| GET | `/posts/feed` | ✓ | `?before&limit` | `PostResponse[]` |
| GET | `/posts/{id}` | — | — | `PostResponse` |
| DELETE | `/posts/{id}` | ✓ | — | `{message}` |
| POST | `/posts/{id}/like` | ✓ | — | `{message}` |
| DELETE | `/posts/{id}/like` | ✓ | — | `{message}` |

### Messenger

| Метод | Путь | Auth | Тело | Ответ |
|---|---|---|---|---|
| GET | `/messenger/ws` | query `?token=` | WS upgrade | WebSocket |
| POST | `/messenger/chats` | ✓ | `{member_ids[], name?, is_group?}` | `ChatResponse` |
| GET | `/messenger/chats` | ✓ | — | `ChatResponse[]` |
| GET | `/messenger/chats/{id}/messages` | ✓ | `?before&limit` | `MessageResponse[]` |

### Notifications

| Метод | Путь | Auth | Тело | Ответ |
|---|---|---|---|---|
| GET | `/notifications` | ✓ | `?offset&limit&unread_only` | `NotificationResponse[]` |
| GET | `/notifications/unread-count` | ✓ | — | `{count}` |
| PATCH | `/notifications/read-all` | ✓ | — | `{message}` |
| PATCH | `/notifications/{id}/read` | ✓ | — | `{message}` |

### Media

| Метод | Путь | Auth | Тело | Ответ |
|---|---|---|---|---|
| POST | `/media/upload` | ✓ | multipart/form-data | `UploadResponse[]` |

`UploadResponse`: `{url, key}` — `url` для отображения, `key` для хранения в БД.

### Формат ошибок

Все ошибки возвращаются в едином формате:

```json
{
  "error": "not_found",
  "message": "User not found"
}
```

| `error` | HTTP статус |
|---|---|
| `bad_request` | 400 |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found` | 404 |
| `conflict` | 409 |
| `validation_error` | 422 |
| `internal_error` / `database_error` | 500 |

---

## 12. База данных — схема

```
users
  id UUID PK
  username VARCHAR(30) UNIQUE
  email VARCHAR(255) UNIQUE
  password_hash TEXT
  display_name VARCHAR(100)
  bio TEXT
  avatar_url TEXT
  is_verified BOOLEAN
  created_at, updated_at TIMESTAMPTZ

follows
  follower_id UUID FK→users
  following_id UUID FK→users
  created_at TIMESTAMPTZ
  PK(follower_id, following_id)

posts
  id UUID PK
  author_id UUID FK→users
  content TEXT
  media_urls TEXT[]
  like_count INT
  repost_count INT
  created_at, updated_at TIMESTAMPTZ

post_likes
  user_id UUID FK→users
  post_id UUID FK→posts
  created_at TIMESTAMPTZ
  PK(user_id, post_id)

chats
  id UUID PK
  name VARCHAR(100)       -- NULL для DM
  is_group BOOLEAN
  created_at TIMESTAMPTZ

chat_members
  chat_id UUID FK→chats
  user_id UUID FK→users
  role VARCHAR(20)        -- 'admin' | 'member'
  joined_at TIMESTAMPTZ
  PK(chat_id, user_id)

messages
  id UUID PK
  chat_id UUID FK→chats
  sender_id UUID FK→users
  encrypted_content TEXT  -- ciphertext (пока plaintext, см. костыли)
  nonce TEXT              -- nonce для шифра
  message_type VARCHAR(20)  -- 'text' | 'media' | 'system'
  created_at TIMESTAMPTZ

user_key_bundles          -- Signal E2E: постоянные ключи
  user_id UUID PK FK→users
  identity_key TEXT
  signed_pre_key TEXT
  signed_pre_key_signature TEXT
  updated_at TIMESTAMPTZ

one_time_pre_keys         -- Signal E2E: одноразовые ключи
  id UUID PK
  user_id UUID FK→users
  key_data TEXT
  used BOOLEAN
  INDEX(user_id, used) WHERE used = FALSE

notifications
  id UUID PK
  user_id UUID FK→users
  notification_type VARCHAR(30)
  data JSONB
  is_read BOOLEAN
  created_at TIMESTAMPTZ

refresh_tokens
  id UUID PK
  user_id UUID FK→users
  token_hash TEXT         -- SHA-256 от токена
  expires_at TIMESTAMPTZ
  created_at TIMESTAMPTZ

---

## 13. Быстрый старт

### Требования

- [Rust](https://rustup.rs/) (stable, 1.75+)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- [Node.js](https://nodejs.org/) 18+
- [sqlx-cli](https://github.com/launchbadge/sqlx/tree/main/sqlx-cli) (опционально, для ручных миграций)

```bash
cargo install sqlx-cli --no-default-features --features rustls,postgres
```

### Первый запуск

```bash
# 1. Клонировать репозиторий
git clone <repo-url>
cd SocialApp

# 2. Поднять инфраструктуру (PostgreSQL, Redis, MinIO, Elasticsearch)
docker-compose up -d

# Убедиться что всё запустилось:
docker-compose ps

# 3. Запустить бэкенд (миграции применяются автоматически при старте)
cd backend
cargo run

# В соседнем терминале — фронтенд
cd frontend
npm install
npm run dev
```

Приложение доступно по адресам:
- Фронтенд: http://localhost:5173
- Бэкенд API: http://localhost:3000/api
- MinIO UI: http://localhost:9001 (логин: diffract_admin / diffract_secret)
- Elasticsearch: http://localhost:9200

### Сброс базы данных

Если нужно полностью пересоздать БД (например, после смены credentials или при конфликте миграций):

```bash
docker-compose down -v   # -v удаляет все Docker volumes
docker-compose up -d
```

### Тестирование чата с двумя аккаунтами

1. Открыть http://localhost:5173 в обычном окне браузера → зарегистрировать `user1`
2. Открыть http://localhost:5173 в режиме инкогнито → зарегистрировать `user2`
3. В любом окне: **Chats → + New** → ввести username второго пользователя
4. Писать сообщения — они появляются в реальном времени в обоих окнах

### Полезные команды

```bash
# Посмотреть логи конкретного контейнера
docker-compose logs -f postgres
docker-compose logs -f elasticsearch

# Подключиться к PostgreSQL напрямую
docker exec -it diffract-postgres psql -U diffract -d diffract

# Применить миграции вручную (если нужно без перезапуска)
cd backend
sqlx migrate run

# Создать новую миграцию
sqlx migrate add <name>

# Сборка в релизном режиме
cargo build --release
```

---

## 14. Как добавить новый модуль

Пример: добавляем модуль `comments` (комментарии к постам).

### Шаг 1 — Создать файлы модуля

```bash
mkdir backend/src/modules/comments
touch backend/src/modules/comments/{mod.rs,models.rs,repo.rs,handlers.rs}
```

### Шаг 2 — `models.rs`

Определить все типы: Request, Response, DB Row.

```rust
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use validator::Validate;

// Запрос от клиента
#[derive(Debug, Deserialize, Validate)]
pub struct CreateCommentRequest {
    #[validate(length(min = 1, max = 1000))]
    pub content: String,
}

// Ответ клиенту
#[derive(Debug, Serialize)]
pub struct CommentResponse {
    pub id: Uuid,
    pub post_id: Uuid,
    pub author_username: String,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

// Строка из БД (sqlx::FromRow)
#[derive(Debug, sqlx::FromRow)]
pub struct CommentRow {
    pub id: Uuid,
    pub post_id: Uuid,
    pub author_id: Uuid,
    pub content: String,
    pub created_at: DateTime<Utc>,
}
```

### Шаг 3 — `repo.rs`

Только SQL, никакой бизнес-логики.

```rust
use sqlx::PgPool;
use uuid::Uuid;

use crate::errors::AppResult;
use super::models::CommentRow;

pub struct CommentsRepo;

impl CommentsRepo {
    pub async fn create(
        pool: &PgPool,
        post_id: Uuid,
        author_id: Uuid,
        content: &str,
    ) -> AppResult<CommentRow> {
        let row = sqlx::query_as::<_, CommentRow>(
            r#"
            INSERT INTO comments (post_id, author_id, content)
            VALUES ($1, $2, $3)
            RETURNING *
            "#,
        )
        .bind(post_id)
        .bind(author_id)
        .bind(content)
        .fetch_one(pool)
        .await?;
        Ok(row)
    }

    pub async fn get_for_post(
        pool: &PgPool,
        post_id: Uuid,
        limit: i64,
        offset: i64,
    ) -> AppResult<Vec<CommentRow>> {
        let rows = sqlx::query_as::<_, CommentRow>(
            "SELECT * FROM comments WHERE post_id = $1 ORDER BY created_at ASC LIMIT $2 OFFSET $3",
        )
        .bind(post_id)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?;
        Ok(rows)
    }
}
```

### Шаг 4 — `handlers.rs`

```rust
use axum::{extract::{Path, State}, Json};
use uuid::Uuid;
use validator::Validate;

use crate::errors::{AppError, AppResult};
use crate::middleware::auth::AuthUser;
use crate::state::AppState;

use super::models::{CommentResponse, CreateCommentRequest};
use super::repo::CommentsRepo;

pub async fn create_comment(
    State(state): State<AppState>,
    user: AuthUser,
    Path(post_id): Path<Uuid>,
    Json(req): Json<CreateCommentRequest>,
) -> AppResult<Json<CommentResponse>> {
    req.validate()
        .map_err(|e| AppError::Validation(e.to_string()))?;

    let row = CommentsRepo::create(&state.db, post_id, user.user_id, &req.content).await?;

    // Подтянуть username для ответа
    let username: String = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(user.user_id)
        .fetch_one(&state.db)
        .await?;

    Ok(Json(CommentResponse {
        id: row.id,
        post_id: row.post_id,
        author_username: username,
        content: row.content,
        created_at: row.created_at,
    }))
}
```

### Шаг 5 — `mod.rs`

```rust
pub mod handlers;
pub mod models;
pub mod repo;

use axum::{routing::{get, post}, Router};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/posts/{post_id}/comments", post(handlers::create_comment))
        .route("/posts/{post_id}/comments", get(handlers::list_comments))
}
```

### Шаг 6 — Подключить в `modules/mod.rs`

```rust
pub mod auth;
pub mod comments;  // добавить
pub mod media;
// ...
```

### Шаг 7 — Подключить роутер в `main.rs`

```rust
let app = Router::new()
    // ... существующие маршруты ...
    .nest("/api", modules::comments::router())  // добавить
    .with_state(state);
```

### Шаг 8 — Добавить миграцию

```bash
cd backend
sqlx migrate add add_comments_table
```

В созданном файле `migrations/YYYYMMDDHHMMSS_add_comments_table.sql`:

```sql
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    author_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comments_post ON comments (post_id, created_at ASC);
```

Миграция применится автоматически при следующем `cargo run`.

---

## 15. План реализации E2E шифрования

Сейчас сообщения хранятся в открытом виде (см. [раздел 4](#4-временные-костыли)). Ниже — пошаговый план замены на настоящий E2E.

### Протокол

Используется упрощённый **Signal Protocol**:
- **X3DH** (Extended Triple Diffie-Hellman) — установка общего секрета между двумя пользователями
- **Double Ratchet** — обновление ключей шифрования с каждым сообщением

Бэкенд не знает содержимого сообщений — он только хранит и доставляет зашифрованные blob'ы.

### Ключи (уже в схеме БД)

| Ключ | Где хранится | Назначение |
|---|---|---|
| Identity Key (IK) | `user_key_bundles.identity_key` (публичный) | Долгосрочная идентификация |
| Signed Pre-Key (SPK) | `user_key_bundles.signed_pre_key` | Среднесрочный ключ (меняется раз в неделю) |
| SPK Signature | `user_key_bundles.signed_pre_key_signature` | Подпись SPK через IK |
| One-Time Pre-Key (OPK) | `one_time_pre_keys.key_data` | Одноразовый, расходуется на X3DH |

Приватные ключи **никогда не покидают устройство** — хранятся только в `localStorage` / IndexedDB клиента.

### Что нужно сделать на фронтенде

**1. Генерация ключей при регистрации/логине**

```js
import { generateKeyBundle } from './crypto.js';

// После успешного логина:
const { identityKey, signedPreKey, oneTimePreKeys, privateKeys } =
    await generateKeyBundle();

// Сохранить приватные ключи локально
localStorage.setItem('private_keys', JSON.stringify(privateKeys));

// Отправить публичные ключи на сервер через WS
sendWs({
    type: 'upload_pre_keys',
    identity_key: identityKey.public,
    signed_pre_key: signedPreKey.public,
    signed_pre_key_signature: signedPreKey.signature,
    one_time_pre_keys: oneTimePreKeys.map(k => k.public),
});
```

**2. Установка сессии (X3DH) перед первым сообщением**

```js
// Запросить key bundle собеседника
sendWs({ type: 'request_key_bundle', user_id: recipientId });

// Обработать ответ (KeyBundle событие)
// → Выполнить X3DH, получить shared secret
// → Инициализировать Double Ratchet
// → Сохранить ratchet state в localStorage
```

**3. Шифрование при отправке**

```js
const { ciphertext, nonce } = await encryptMessage(text, ratchetState);

sendWs({
    type: 'send_message',
    chat_id: chatId,
    encrypted_content: btoa(ciphertext),  // base64
    nonce: btoa(nonce),
});
```

**4. Расшифровка при получении**

```js
const plaintext = await decryptMessage(
    atob(msg.encrypted_content),
    atob(msg.nonce),
    ratchetState
);
```

### Рекомендуемые библиотеки

| Библиотека | Назначение |
|---|---|
| `libsodium-wrappers` | Низкоуровневые crypto примитивы (X25519, XSalsa20, Ed25519) |
| `@privacyresearch/libsignal-protocol-typescript` | Готовая реализация Signal Protocol |

Бэкенд при этом **не меняется** — он уже принимает и хранит `encrypted_content` и `nonce` как строки, не интерпретируя их.

### Что нужно изменить на бэкенде

Только одно: закрыть WebSocket соединение если клиент не отправил `upload_pre_keys` в течение N секунд после подключения (опционально, для защиты от клиентов без E2E поддержки).

---

## 16. Следующие итерации (приоритизированный список)

Упорядочено по соотношению ценность / сложность реализации.

### Итерация 1 — Стабилизация (сделать сейчас)

- [ ] **Уведомления из других модулей** — вызывать `NotificationsRepo::create()` при лайке, follow, новом сообщении
- [ ] **N+1 в ленте** — заменить отдельный SELECT автора на JOIN в `PostsRepo::feed()`
- [ ] **N+1 в чатах** — заменить отдельные SELECT участников на батчевый `WHERE id = ANY($1)`
- [ ] **CORS** — ограничить `allow_origin` до `diffract.ru` через конфиг вместо `Any`

### Итерация 2 — Фичи мессенджера

- [ ] **Безопасная WS-аутентификация** — токен первым сообщением, не в URL
- [ ] **E2E шифрование** — реализовать `crypto.js` на фронте (см. раздел 15)
- [ ] **Групповые чаты через UI** — форма создания с множественным выбором участников
- [ ] **Индикатор онлайн** — `ConnectionHub::is_online()` уже есть, нужен эндпоинт и UI

### Итерация 3 — Социальные функции

- [ ] **Репосты** — бэкенд: поле `repost_of UUID FK→posts`, хендлер; фронт: кнопка
- [ ] **Комментарии** — новый модуль (шаблон в разделе 14)
- [ ] **Упоминания** — парсинг `@username` в тексте поста, уведомления
- [ ] **Хэштеги** — парсинг `#tag`, таблица `hashtags`, страница тега

### Итерация 4 — Поиск

- [ ] **Индексация в Elasticsearch** — при создании поста/регистрации пользователя пушить в ES
- [ ] **Эндпоинт `/api/search`** — поиск по пользователям и постам одновременно
- [ ] **UI поиска** — строка в хедере, результаты с разбивкой по типам

### Итерация 5 — Качество и масштабирование

- [ ] **Rate limiting** — подключить `tower_http::limit` middleware, лимиты по IP и по user_id
- [ ] **Верификация email** — отправка кода, подтверждение, поле `is_verified`
- [ ] **Блокировки пользователей** — таблица `blocks`, фильтрация в ленте и мессенджере
- [ ] **Алгоритмическая лента** — скоринг постов через Redis Sorted Sets (лайки × вес + свежесть)
- [ ] **Замена Redis pub/sub для WS** — текущий `ConnectionHub` работает в памяти одного процесса; при горизонтальном масштабировании нужен Redis pub/sub для рассылки между инстансами

### Итерация 6 — Деплой

- [ ] **Dockerfile** для бэкенда (multi-stage: builder → slim runtime)
- [ ] **Nginx** как reverse proxy + SSL termination
- [ ] **GitHub Actions** CI/CD — сборка, тесты, деплой
- [ ] **Мониторинг** — Prometheus + Grafana или аналог
```
