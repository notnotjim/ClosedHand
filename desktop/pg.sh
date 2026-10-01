#!/bin/sh
# Builds a relocatable Postgres 16 + pgvector into $PREFIX for the app bundle.
# No readline, ICU, OpenSSL or zlib: the server only ever talks to the two
# processes beside it over localhost, and every outside library would be one
# more thing to ship and sign.
set -e
PG_VERSION="${PG_VERSION:-16.15}"
PREFIX="${PREFIX:?set PREFIX}"
WORK="$(mktemp -d)"
export MACOSX_DEPLOYMENT_TARGET=14.0
cd "$WORK"
curl -sfLO "https://ftp.postgresql.org/pub/source/v$PG_VERSION/postgresql-$PG_VERSION.tar.bz2"
tar xjf "postgresql-$PG_VERSION.tar.bz2"
git clone -q --depth 1 https://github.com/pgvector/pgvector.git
cd "postgresql-$PG_VERSION"
./configure --prefix="$PREFIX" --without-readline --without-icu --without-openssl --without-zlib --disable-nls --disable-debug >/dev/null
make -j"$(sysctl -n hw.ncpu)" -s >/dev/null
make -s install >/dev/null
cd ../pgvector
make -s PG_CONFIG="$PREFIX/bin/pg_config" >/dev/null
make -s install PG_CONFIG="$PREFIX/bin/pg_config" >/dev/null
cd "$PREFIX"
rm -rf include share/doc share/man
find bin -type f ! \( -name postgres -o -name initdb -o -name pg_ctl -o -name pg_isready -o -name psql -o -name pg_dump -o -name pg_restore -o -name pg_config \) -delete
# Executables find libpq beside themselves, wherever the bundle ends up.
for b in bin/*; do
  for lib in $(otool -L "$b" | awk -v p="$PREFIX/lib" 'index($1,p)==1 {print $1}'); do
    install_name_tool -change "$lib" "@executable_path/../lib/$(basename "$lib")" "$b" 2>/dev/null || true
  done
done
for d in lib/*.dylib; do install_name_tool -id "@rpath/$(basename "$d")" "$d" 2>/dev/null || true; done
rm -rf "$WORK"
echo "Postgres $PG_VERSION + pgvector in $PREFIX"
