-- Roll the code back to a build that predates 0049 before running this:
-- the image warm job reads the view and writes the table.  Dropping the
-- table loses only the record of what has been asked; nginx keeps the
-- originals it stored, and the job's first pass after 0049 is applied again
-- asks for every referenced URL once more, which nginx answers from what it
-- already holds.
DROP VIEW IF EXISTS image_refs;
DROP TABLE IF EXISTS image_manager;
