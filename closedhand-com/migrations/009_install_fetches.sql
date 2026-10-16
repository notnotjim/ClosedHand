-- How many times a day the install command fetched the script through
-- closedhand.com/install. A count only: nothing about who asked.
CREATE TABLE install_fetches (
  day date PRIMARY KEY,
  fetches integer NOT NULL DEFAULT 0
);
