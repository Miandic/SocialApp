# Diffract — UML-диаграммы архитектуры

Документ описывает фактическую архитектуру проекта по состоянию на текущую ревизию. Диаграммы написаны в Mermaid и отображаются в GitHub, GitLab, Obsidian и редакторах с поддержкой Mermaid.

## 1. Общая архитектура и развёртывание

```mermaid
flowchart LR
    browser["Браузер\nVanilla JS + Vite"]
    vite["Vite dev server\n:5173\nproxy /api"]
    api["Diffract backend\nRust + Tokio + Axum\n:3000"]

    pg[("PostgreSQL 16\nосновные данные")]
    redis[("Redis 7\nподключён в AppState\nрезерв для cache/pubsub")]
    minio[("MinIO\nS3-compatible\nмедиа-файлы")]
    es[("Elasticsearch 8.13\nподключён в docker-compose\nпоиск пока не реализован")]

    browser -->|HTTP REST /api| vite
    browser -->|WebSocket /api/messenger/ws| vite
    vite -->|proxy HTTP + WS| api
    api -->|SQLx connection pool| pg
    api -->|Redis connection manager| redis
    api -->|AWS SDK S3| minio
    api -.->|будущее: индексация и поиск| es
```

Локальные порты: frontend `5173`, backend `3000`, PostgreSQL `5432`, Redis `6379`, MinIO API `9000`, MinIO console `9001`, Elasticsearch `9200`.

## 2. Backend: компонентная UML-диаграмма

```mermaid
flowchart TB
    client["Frontend / Browser"]
    router["Axum Router\nCORS + trace + body limit"]
    authmw["Auth extractors\nAuthUser / OptionalAuthUser\nJWT access token"]
    state["AppState\nPgPool · Redis · Config\nS3Client · ConnectionHub"]

    subgraph modules["Модульный монолит backend/src/modules"]
        auth["Auth\nregister · login · refresh\nlogout · me · password check"]
        users["Users\nprofiles · follow graph"]
        posts["Posts\ncreate · feed · likes"]
        messenger["Messenger\nREST chats/messages\nWebSocket real-time"]
        devices["Devices\nE2EE devices · pre-keys\nhistory sync"]
        notifications["Notifications\nlist · read · unread count"]
        media["Media\nmultipart validation\nS3 upload"]
    end

    subgraph layers["Типовые слои модулей"]
        handlers["handlers.rs\nHTTP/WS transport"]
        service["service.rs\nбизнес-логика\n(есть в Auth и Media)"]
        repo["repo.rs\nSQL queries"]
        models["models.rs\nrequest/response/DB models"]
    end

    client --> router
    router --> authmw
    authmw --> modules
    router --> modules
    modules --> state
    auth --> handlers
    users --> handlers
    posts --> handlers
    messenger --> handlers
    devices --> handlers
    notifications --> handlers
    media --> handlers
    handlers --> service
    handlers --> repo
    service --> repo
    handlers -.-> models
    repo -.-> models
```

Все модули собираются в один бинарник и получают общее состояние через Axum `State<AppState>`. Границы модулей сейчас организационные, а не сетевые: отдельные процессы/микросервисы не создаются.

## 3. Backend: маршруты и модули

```mermaid
classDiagram
    class AppState {
      +PgPool db
      +RedisConnectionManager redis
      +Config config
      +S3Client s3_client
      +ConnectionHub hub
    }

    class Router {
      +/api/auth
      +/api/devices
      +/api/users
      +/api/posts
      +/api/messenger
      +/api/notifications
      +/api/media
    }

    class AuthModule {
      +POST /register
      +POST /login
      +POST /refresh
      +POST /logout
      +GET /me
      +POST /verify-password
    }
    class UsersModule {
      +GET /{username}
      +PATCH /profile
      +POST|DELETE /{username}/follow
      +GET /followers|following
    }
    class PostsModule {
      +POST /
      +GET /feed
      +GET|DELETE /{id}
      +POST|DELETE /{id}/like
    }
    class MessengerModule {
      +GET /ws
      +POST|GET /chats
      +GET /chats/{id}/messages
    }
    class DevicesModule {
      +POST|GET /
      +POST /{id}/approve
      +DELETE /{id}
      +POST /{id}/pre-keys
      +GET /user-bundles/{user_id}
      +POST|GET|DELETE /history-sync
    }
    class NotificationsModule {
      +GET /
      +GET /unread-count
      +PATCH /read-all
      +PATCH /{id}/read
    }
    class MediaModule {
      +POST /upload
    }

    Router --> AppState
    Router --> AuthModule
    Router --> UsersModule
    Router --> PostsModule
    Router --> MessengerModule
    Router --> DevicesModule
    Router --> NotificationsModule
    Router --> MediaModule
```

## 4. Backend: зависимости от внешних хранилищ

```mermaid
flowchart LR
    subgraph backend["Rust backend"]
        auth[Auth repo/service]
        users[Users repo]
        posts[Posts repo]
        msg[Messenger repo + WS]
        devices[Devices repo]
        notif[Notifications repo]
        media[Media service]
    end

    pg[(PostgreSQL)]
    redis[(Redis)]
    s3[(MinIO / S3)]
    es[(Elasticsearch)]
    hub["ConnectionHub\nпамять процесса"]

    auth --> pg
    users --> pg
    posts --> pg
    msg --> pg
    devices --> pg
    notif --> pg
    media --> s3
    msg --> hub
    backend -.-> redis
    backend -.->|не используется в модулях сейчас| es
```

`PostgreSQL` — единственное хранилище, реально используемое бизнес-модулями в SQL-запросах. `ConnectionHub` хранит активные WS-соединения только в памяти процесса, поэтому состояние online/маршрутизация не являются распределёнными при запуске нескольких экземпляров backend. Redis присутствует в `AppState`, но активная логика модулей его не использует. Elasticsearch присутствует в конфигурации и Docker Compose, но поисковые endpoints и индексация не написаны.

## 5. Frontend: компонентная UML-диаграмма

```mermaid
flowchart TB
    html["index.html"] --> main["main.js\nSPA UI + routing\nrender functions"]
    main --> api["api.js\nREST API client\nJWT refresh"]
    main --> crypto["crypto.js\nE2EE + device lifecycle"]
    main --> css["style.css"]
    main --> emoji["Apple emoji assets\ncopy-emoji script"]

    api --> rest["HTTP fetch /api"]
    api --> ws["WebSocket\n/api/messenger/ws"]
    crypto --> indexed["IndexedDB\ndiffract-crypto / keys"]
    crypto --> webcrypto["Web Crypto API\nX25519 · HKDF · AES-GCM"]
    rest --> backend["Rust backend"]
    ws --> backend
```

Фронтенд — одностраничное приложение без отдельного UI-фреймворка. `main.js` совмещает навигацию, состояние приложения и рендеринг экранов. `api.js` централизует REST-вызовы и автоматический refresh JWT. `crypto.js` хранит приватные ключи и сессионные ключи в IndexedDB браузера.

## 6. Сценарий аутентификации

```mermaid
sequenceDiagram
    actor U as Пользователь
    participant UI as main.js
    participant API as Axum / Auth
    participant S as AuthService
    participant DB as PostgreSQL

    U->>UI: Ввод login/password
    UI->>API: POST /api/auth/login
    API->>S: login(credentials)
    S->>DB: найти пользователя
    DB-->>S: user + password_hash
    S->>S: Argon2 verify + JWT pair
    S->>DB: сохранить hash refresh token
    S-->>API: access + refresh + user
    API-->>UI: AuthResponse
    UI->>UI: localStorage: access_token, refresh_token

    UI->>API: защищённый REST request
    API->>API: AuthUser проверяет Bearer JWT
    API-->>UI: данные или 401
    UI->>API: POST /auth/refresh при 401
    API->>DB: найти и удалить старый refresh hash
    API->>DB: сохранить новый refresh hash
    API-->>UI: новая пара токенов
```

## 7. Сценарий чата и E2EE

```mermaid
sequenceDiagram
    participant B as Browser
    participant C as crypto.js
    participant API as Devices REST
    participant WS as Messenger WebSocket
    participant H as ConnectionHub
    participant DB as PostgreSQL

    B->>C: loadOrCreateIdentityKeys()
    C->>C: X25519 identity + pre-keys
    C->>API: POST /api/devices (public bundle)
    API->>DB: user_devices + one_time_pre_keys

    B->>API: GET /api/devices/user-bundles/{user_id}
    API->>DB: получить bundles устройств
    DB-->>API: public identity/pre-keys
    API-->>B: key bundles
    B->>C: ECDH + HKDF => AES-GCM session keys
    C->>C: encryptForDevices(plaintext)

    B->>WS: connect ?token=JWT&device_id=UUID
    WS->>DB: проверить device принадлежит user
    WS->>H: register(user_id, device_id)
    B->>WS: send_message(device_ciphertexts)
    WS->>DB: сохранить opaque ciphertext
    WS->>H: разослать ciphertext online devices
    H-->>B: new_message
    B->>C: decryptMessage()
    C-->>B: plaintext для UI
```

Сервер не должен расшифровывать содержимое сообщений: в БД хранятся `encrypted_content`/`nonce` и отдельные ciphertext для устройств. При этом текущая реализация передаёт JWT WebSocket через query parameter — это отмечено в `ARCHITECTURE.md` как технический долг.

## 8. Сценарий загрузки медиа

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as POST /api/media/upload
    participant M as Media handler/service
    participant S3 as MinIO S3

    B->>API: multipart files + Bearer JWT
    API->>API: AuthUser + body limit 200 MB
    API->>M: validate MIME/size
    M->>S3: PutObject(bucket, key, bytes)
    S3-->>M: object stored
    M-->>API: public URL + object key
    API-->>B: [{url, key}]
    B->>S3: загрузить объект по URL для отображения
```

Bucket создаётся при старте backend, а `MediaService` выставляет public-read policy. URL медиа возвращается клиенту; сами ссылки не сохраняются автоматически в пост — интеграция медиа с постами пока неполная.

## 9. Данные PostgreSQL

```mermaid
erDiagram
    USERS ||--o{ FOLLOWS : follower
    USERS ||--o{ FOLLOWS : following
    USERS ||--o{ POSTS : authors
    USERS ||--o{ POST_LIKES : likes
    POSTS ||--o{ POST_LIKES : receives
    CHATS ||--o{ CHAT_MEMBERS : contains
    USERS ||--o{ CHAT_MEMBERS : joins
    CHATS ||--o{ MESSAGES : contains
    USERS ||--o{ MESSAGES : sends
    USERS ||--o{ USER_DEVICES : owns
    USER_DEVICES ||--o{ ONE_TIME_PRE_KEYS : provides
    MESSAGES ||--o{ MESSAGE_DEVICE_CIPHERTEXTS : encrypted_for
    USER_DEVICES ||--o{ MESSAGE_DEVICE_CIPHERTEXTS : receives
    USERS ||--o{ NOTIFICATIONS : receives
    USERS ||--o{ REFRESH_TOKENS : authenticates
    USER_DEVICES ||--o{ HISTORY_SYNC_PACKAGES : sender
    USER_DEVICES ||--o{ HISTORY_SYNC_PACKAGES : recipient

    USERS { uuid id PK; string username UK; string email UK; string password_hash }
    FOLLOWS { uuid follower_id PK; uuid following_id PK }
    POSTS { uuid id PK; uuid author_id FK; text content; text_array media_urls }
    POST_LIKES { uuid user_id PK; uuid post_id PK }
    CHATS { uuid id PK; boolean is_group; string name }
    CHAT_MEMBERS { uuid chat_id PK; uuid user_id PK; uuid last_read_message_id FK }
    MESSAGES { uuid id PK; uuid chat_id FK; uuid sender_id FK; uuid sender_device_id FK; text encrypted_content; text nonce }
    USER_DEVICES { uuid id PK; uuid user_id FK; text identity_key; boolean is_verified }
    ONE_TIME_PRE_KEYS { uuid id PK; uuid device_id FK; text key_data; boolean used }
    MESSAGE_DEVICE_CIPHERTEXTS { uuid message_id PK; uuid device_id PK; text encrypted_content; text nonce }
    NOTIFICATIONS { uuid id PK; uuid user_id FK; string notification_type; json data; boolean is_read }
    REFRESH_TOKENS { uuid id PK; uuid user_id FK; text token_hash; datetime expires_at }
    HISTORY_SYNC_PACKAGES { uuid id PK; uuid sender_device_id FK; uuid recipient_device_id FK; text ciphertext; datetime expires_at }
```

Схема формируется миграциями `0001_init.sql` и `0002_e2ee_devices.sql`. Вторая миграция переводит E2EE-ключи и one-time pre-keys с уровня пользователя на уровень устройства и добавляет ciphertext-per-device.

## 10. Что важно помнить при чтении проекта

- Реализован модульный монолит, а не набор микросервисов.
- PostgreSQL — рабочая зависимость всех репозиториев; Redis и Elasticsearch пока не дают бизнес-функций в текущем коде.
- Real-time маршрутизация выполняется через in-memory `ConnectionHub`; для горизонтального масштабирования потребуется общий pub/sub и sticky/совместимая WS-инфраструктура.
- E2EE-логика в основном клиентская; backend хранит и пересылает ciphertext.
- Frontend Vite proxy нужен только для локальной разработки; production reverse proxy должен направлять `/api` и WebSocket на backend.
- Диаграммы отражают текущий код, а не будущие функции из раздела «план» в `ARCHITECTURE.md`.
