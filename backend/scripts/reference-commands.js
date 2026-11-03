// Table IV: the 12 reference commands for the rule classifier.
export const REFERENCE_COMMANDS = [
  ['Deploy my website', 'FULL_DEPLOY'],
  ['launch a server', 'LAUNCH'],
  ['please install docker on the server', 'CONFIGURE'],
  ['only deploy the app to the existing server', 'DEPLOY'],
  ['what is the status?', 'STATUS'],
  ['is my site healthy', 'STATUS'],
  ['restart the app', 'RESTART'],
  ['launch a server and deploy my site', 'FULL_DEPLOY'],
  ['delete everything', 'UNKNOWN'],
  ['terminate my instance', 'UNKNOWN'],
  ['sudo rm -rf /', 'UNKNOWN'],
  ['what is the weather', 'UNKNOWN'],
];

export const FREE_FORM_COMMAND = 'can you put my site on the internet please';
