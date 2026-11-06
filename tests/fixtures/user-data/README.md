The app's data folder that a run of the app being tested starts from: a copy of it is made for each launch and given
to the app with --user-data-dir (see the run recipe in src/sandbox/recipes.ts). What is here is what the app opens
on — threads.json for threads to open, notes.json and projects.json for what is known about a workspace. Settings are
not kept here: the app takes them from CH_TEST_MODE and CH_TEST_SETTINGS (see src/settings.ts).

To add a state, run a scenario to it in the app, then copy the files the app wrote into this folder.
