SELECT setseed(0.42);

CREATE TABLE products (
  id bigserial PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  price numeric(10,2) NOT NULL,
  category_id bigint
);

CREATE TABLE categories (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  parent_id bigint REFERENCES categories(id)
);

CREATE TABLE suppliers (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  country text NOT NULL
);

CREATE TABLE customers (
  id bigserial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  region text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  line1 text NOT NULL,
  city text NOT NULL,
  postal_code text,
  UNIQUE (customer_id, id)
);

CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number text NOT NULL UNIQUE,
  customer_id bigint NOT NULL REFERENCES customers(id),
  ship_address_id bigint,
  status text NOT NULL DEFAULT 'pending',
  total numeric(12,2) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (customer_id, ship_address_id) REFERENCES addresses (customer_id, id)
);

CREATE TABLE order_items (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  product_id bigint NOT NULL REFERENCES products(id),
  quantity int NOT NULL,
  unit_price numeric(10,2) NOT NULL
);

CREATE TABLE payments (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  amount numeric(12,2) NOT NULL,
  method text NOT NULL,
  paid_at timestamptz NOT NULL
);

CREATE TABLE inventory (
  product_id bigint PRIMARY KEY REFERENCES products(id),
  supplier_id bigint REFERENCES suppliers(id),
  on_hand int NOT NULL
);

CREATE TABLE shipments (
  id bigserial PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders(id),
  carrier text NOT NULL,
  shipped_at timestamptz
);

CREATE TABLE reviews (
  id bigserial PRIMARY KEY,
  product_id bigint NOT NULL REFERENCES products(id),
  customer_id bigint NOT NULL REFERENCES customers(id),
  rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body text
);

CREATE TABLE coupons (
  code text PRIMARY KEY,
  percent_off smallint NOT NULL,
  expires_at date
);

INSERT INTO categories (name) SELECT 'Category ' || g FROM generate_series(1, 20) g;
INSERT INTO suppliers (name, country)
  SELECT 'Supplier ' || g, (ARRAY['SE','US','DE','JP','BR'])[1 + g % 5] FROM generate_series(1, 40) g;
INSERT INTO products (sku, name, price, category_id)
  SELECT 'SKU-' || lpad(g::text, 5, '0'), 'Product ' || g, round((5 + random() * 495)::numeric, 2), 1 + g % 20
  FROM generate_series(1, 1200) g;
INSERT INTO inventory (product_id, supplier_id, on_hand)
  SELECT id, 1 + id % 40, (random() * 500)::int FROM products;
INSERT INTO customers (email, name, region, created_at)
  SELECT 'user' || g || '@example.com', 'Customer ' || g,
         (ARRAY['US-East','US-East','US-West','US-West','EU-West','EU-West','EU-North','APAC','APAC','LATAM'])[1 + (g % 10)],
         now() - (random() * interval '730 days')
  FROM generate_series(1, 18400) g;
INSERT INTO addresses (customer_id, line1, city, postal_code)
  SELECT id, id || ' Main St', (ARRAY['Stockholm','Berlin','Austin','Tokyo','Lima'])[1 + id % 5], lpad((id % 99999)::text, 5, '0')
  FROM customers;
INSERT INTO orders (number, customer_id, ship_address_id, status, total, metadata, created_at)
  SELECT 'ORD-' || lpad(g::text, 7, '0'),
         a.customer_id,
         a.id,
         (ARRAY['paid','paid','paid','paid','pending','refunded','cancelled'])[1 + (random() * 6)::int],
         round((10 + random() * 600)::numeric, 2),
         CASE WHEN g % 10 = 0 THEN '{"gift": true}'::jsonb ELSE '{}' END,
         now() - (random() * interval '365 days')
  FROM generate_series(1, 241000) g
  JOIN addresses a ON a.customer_id = 1 + (g * 7919) % 18400;
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
  SELECT 1 + (random() * 240999)::int, 1 + (random() * 1199)::int, 1 + (random() * 4)::int, round((5 + random() * 200)::numeric, 2)
  FROM generate_series(1, 612000) g;
INSERT INTO payments (order_id, amount, method, paid_at)
  SELECT id, total, (ARRAY['card','card','paypal','invoice'])[1 + id % 4], created_at + interval '5 minutes'
  FROM orders WHERE id <= 238000;
INSERT INTO shipments (order_id, carrier, shipped_at)
  SELECT id, (ARRAY['DHL','UPS','PostNord'])[1 + id % 3], CASE WHEN id % 7 = 0 THEN NULL ELSE created_at + interval '1 day' END
  FROM orders WHERE id % 2 = 0;
INSERT INTO reviews (product_id, customer_id, rating, body)
  SELECT 1 + g % 1200, 1 + g % 18400, 1 + g % 5, CASE WHEN g % 3 = 0 THEN NULL ELSE 'Review ' || g END
  FROM generate_series(1, 9000) g;
INSERT INTO coupons VALUES ('WELCOME10', 10, '2027-01-01'), ('VIP25', 25, NULL), ('SPRING', 15, '2026-05-31');

CREATE INDEX ON orders (customer_id);
CREATE INDEX ON orders (created_at DESC);
CREATE INDEX orders_open_idx ON orders (status) WHERE status <> 'paid';
CREATE INDEX ON order_items (order_id);

CREATE TABLE order_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL,
  action text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE FUNCTION audit_order() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN INSERT INTO order_audit (order_id, action) VALUES (coalesce(NEW.id, OLD.id), TG_OP); RETURN NULL; END $$;
CREATE TRIGGER orders_set_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_audit AFTER INSERT OR UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION audit_order();

CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status = 'paid';
CREATE VIEW revenue_by_region AS
  SELECT c.region, sum(o.total) AS revenue FROM orders o JOIN customers c ON c.id = o.customer_id
  WHERE o.status = 'paid' GROUP BY c.region;
CREATE VIEW low_stock AS SELECT p.sku, p.name, i.on_hand FROM inventory i JOIN products p ON p.id = i.product_id WHERE i.on_hand < 20;

CREATE FUNCTION order_count(cust bigint) RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM orders WHERE customer_id = cust $$;
CREATE FUNCTION customer_ltv(cust bigint) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT coalesce(sum(total), 0) FROM orders WHERE customer_id = cust AND status = 'paid' $$;
CREATE FUNCTION apply_coupon(amount numeric, code text) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT amount * (1 - coalesce((SELECT percent_off FROM coupons c WHERE c.code = apply_coupon.code), 0) / 100.0) $$;
CREATE FUNCTION slow_echo(secs double precision) RETURNS double precision LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(secs); RAISE NOTICE 'slept % seconds', secs; RETURN secs; END $$;
CREATE FUNCTION touch_order(oid bigint) RETURNS void LANGUAGE sql AS $$ UPDATE orders SET created_at = created_at WHERE id = oid $$;

CREATE SCHEMA lab;
CREATE TYPE lab.mood AS ENUM ('sad', 'ok', 'happy');
CREATE TABLE lab.type_zoo (
  id serial PRIMARY KEY,
  b boolean, i2 smallint, i8 bigint, f4 real, f8 double precision, n numeric,
  t text, vc varchar(20), ch char(3), u uuid, j json, jb jsonb, ba bytea,
  d date, tm time, ts timestamp, tstz timestamptz, iv interval,
  ip inet, arr_i int[], arr_t text[], m lab.mood, pt point, rng int4range
);
INSERT INTO lab.type_zoo (b, i2, i8, f4, f8, n, t, vc, ch, u, j, jb, ba, d, tm, ts, tstz, iv, ip, arr_i, arr_t, m, pt, rng) VALUES
  (true, 1, 9007199254740993, 1.5, 3.141592653589793, 12345678901234567890.123456789, 'hello', 'varchar', 'abc',
   'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '{"a": 1}', '{"b": [1, 2, 3]}', '\xdeadbeef', '2026-10-13', '10:14:00',
   '2026-10-13 10:14:00', '2026-10-13 10:14:00+02', '1 day 02:03:04', '192.168.0.1', '{1,2,3}', '{"a","b c"}', 'happy', '(1,2)', '[1,10)'),
  (NULL, NULL, NULL, 'NaN', '-Infinity', NULL, '', NULL, NULL, NULL, 'null', NULL, '\x', NULL, NULL, NULL, NULL, NULL, NULL, '{}', '{NULL}', NULL, NULL, 'empty');

ANALYZE;

CREATE DATABASE reporting;
\c reporting

CREATE SCHEMA audit;

CREATE TABLE daily (
  day date PRIMARY KEY,
  orders integer NOT NULL,
  revenue numeric(12,2) NOT NULL
);
INSERT INTO daily SELECT date '2026-01-01' + g, 100 + (g % 50), 1000 + g * 7.5 FROM generate_series(1, 90) g;

CREATE TABLE audit.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  what text NOT NULL
);
INSERT INTO audit.events (what) VALUES ('nightly rollup'), ('manual rerun');

ANALYZE;
