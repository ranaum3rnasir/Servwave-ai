const path = require('path');

module.exports = {
  pdf_options: {
    format: 'Letter',
    margin: {
      top: '22mm',
      bottom: '22mm',
      left: '24mm',
      right: '24mm',
    },
    displayHeaderFooter: false,
    printBackground: true,
  },
  stylesheet: [path.join(__dirname, '_pdf-style.css')],
  launch_options: {
    executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  },
};
