-- Roll the code back to a build that predates 0044 before running this:
-- the profiles sweep writes both tables.  Nothing else reads them, so
-- dropping them loses only what the sweep fetches again once the build
-- that has it is back.
DROP TABLE IF EXISTS characters;
DROP TABLE IF EXISTS people;
