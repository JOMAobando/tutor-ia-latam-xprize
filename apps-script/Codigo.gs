// ═══════════════════════════════════════════════════════════
// CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════
const PROJECT_ID = 'tutor-ia-latam-xprize-19910926';
const FIRESTORE_DATABASE = 'default';
const PHONE_NUMBER_ID = PropertiesService.getScriptProperties().getProperty('PHONE_NUMBER_ID');

// ═══════════════════════════════════════════════════════════
// GENERAR TOKEN OAUTH PARA FIRESTORE (vía JWT firmado)
// ═══════════════════════════════════════════════════════════
function getFirestoreAccessToken() {
  var clientEmail = PropertiesService.getScriptProperties().getProperty('FIRESTORE_CLIENT_EMAIL');
  var privateKey = PropertiesService.getScriptProperties().getProperty('FIRESTORE_PRIVATE_KEY').replace(/\\n/g, '\n');

  var header = { alg: 'RS256', typ: 'JWT' };
  var now = Math.floor(Date.now() / 1000);
  var claimSet = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  var base64Header = Utilities.base64EncodeWebSafe(JSON.stringify(header));
  var base64ClaimSet = Utilities.base64EncodeWebSafe(JSON.stringify(claimSet));
  var signatureInput = base64Header + '.' + base64ClaimSet;

  var signature = Utilities.computeRsaSha256Signature(signatureInput, privateKey);
  var base64Signature = Utilities.base64EncodeWebSafe(signature);

  var jwt = signatureInput + '.' + base64Signature;

  var response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });

  var result = JSON.parse(response.getContentText());
  if (result.error) {
    Logger.log('❌ Error obteniendo token OAuth: ' + response.getContentText());
    return null;
  }
  return result.access_token;
}

// ═══════════════════════════════════════════════════════════
// ESCRIBIR/ACTUALIZAR DOCUMENTO DE ESTUDIANTE EN FIRESTORE
// ═══════════════════════════════════════════════════════════
function actualizarEstudianteFirestore(numeroWhatsapp, mensajeDiagnostico, datosEstudiante) {
  var accessToken = getFirestoreAccessToken();
  if (!accessToken) {
    Logger.log('❌ No se pudo obtener token, abortando escritura a Firestore');
    return false;
  }

  var numeroLimpio = numeroWhatsapp.replace(/[\s\-\+]/g, '');
  var url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID +
            '/databases/' + FIRESTORE_DATABASE +
            '/documents/estudiantes/' + numeroLimpio;

  // Estructura de Firestore REST API: cada campo necesita su tipo explícito
  var firestoreDoc = {
    fields: {
      status: { stringValue: 'esperando_formulario' },
      nombre: { stringValue: datosEstudiante.nombre || '' },
      examen: { stringValue: datosEstudiante.examen || '' },
      fecha_examen: { stringValue: datosEstudiante.fechaExamen || '' },
      puntaje_diagnostico: { stringValue: String(datosEstudiante.puntaje || '') },
      fallas_detectadas: { stringValue: (datosEstudiante.fallas || []).join(', ') },
      chat_history: {
        arrayValue: {
          values: [
            {
              mapValue: {
                fields: {
                  role: { stringValue: 'model' },
                  text: { stringValue: mensajeDiagnostico }
                }
              }
            }
          ]
        }
      }
    }
  };

  // PATCH con updateMask para no sobreescribir chat_history existente,
  // pero como chat_history se está estableciendo desde cero aquí
  // (primer mensaje del estudiante), usamos PATCH simple.
  var options = {
    method: 'patch',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + accessToken },
    payload: JSON.stringify(firestoreDoc),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();

  if (responseCode === 200) {
    Logger.log('✅ Firestore actualizado correctamente para ' + numeroLimpio);
    return true;
  } else {
    Logger.log('❌ Error actualizando Firestore: ' + response.getContentText());
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// TRIGGER PRINCIPAL: AL ENVIAR EL FORMULARIO
// ═══════════════════════════════════════════════════════════
function onFormSubmit(e) {
  try {
    Logger.log('EVENTO COMPLETO: ' + JSON.stringify(e));

    var v = e.values || [];

    var timestamp      = v[0];  // A - Marca temporal
    var email          = v[1];  // B - Correo electrónico
    var nombreCompleto = v[2];  // C - Nombre completo
    var pais           = v[3];  // D - País
    var whatsapp       = v[4];  // E - WhatsApp
    var examen         = v[5];  // F - Examen a presentar
    var fechaExamen    = v[6];  // G - Fecha del examen
    var respMat        = v[7];  // H - Matemáticas
    var respLec        = v[8];  // I - Lectura Crítica
    var respCie        = v[9];  // J - Ciencias Naturales
    var respLog        = v[10]; // K - Razonamiento Lógico
    var respSoc        = v[11]; // L - Ciencias Sociales
    var areaDificultad = v[12]; // M - Área de dificultad

    var puntaje = 0;
    var fallas = [];

    if (respMat && (respMat.includes('B') || respMat.includes('10'))) { puntaje++; } else { fallas.push('Matemáticas'); }
    if (respLec && (respLec.includes('C') || respLec.includes('Defender'))) { puntaje++; } else { fallas.push('Lectura Crítica'); }
    if (respCie && (respCie.includes('B') || respCie.includes('Ribosoma'))) { puntaje++; } else { fallas.push('Ciencias Naturales'); }
    if (respLog && (respLog.includes('B') || respLog.includes('162'))) { puntaje++; } else { fallas.push('Razonamiento Lógico'); }
    if (respSoc && (respSoc.includes('C') || respSoc.includes('corales'))) { puntaje++; } else { fallas.push('Ciencias Sociales'); }

    var nivel = puntaje <= 2 ? 'CRÍTICO — Requiere refuerzo urgente' : puntaje == 3 ? 'INTERMEDIO — Hay brechas importantes' : 'AVANZADO — Requiere optimización fina';
    var primerNombre = nombreCompleto ? nombreCompleto.split(' ')[0] : 'Estudiante';

    var mensaje = 'Hola ' + primerNombre + ' 👋\n\n';
    mensaje += '📊 *Resultado: ' + puntaje + '/5 — ' + nivel + '*\n\n';

    if (fallas.length > 0) {
      mensaje += '⚠️ *Áreas con fallas detectadas:*\n';
      fallas.forEach(function(f) { mensaje += '• ' + f + '\n'; });
      mensaje += '\n';
    }

    if (areaDificultad && areaDificultad !== '') {
      mensaje += '📌 *Tú identificaste como difícil:* ' + areaDificultad + '\n\n';
    }

    if (fechaExamen && fechaExamen !== '') {
      mensaje += '📅 Tu examen es el *' + fechaExamen + '*. El tiempo es clave.\n\n';
    }

    mensaje += 'Nuestro Tutor IA trabaja exactamente en tus puntos débiles, 24/7 por WhatsApp, por solo $19 USD/mes.\n\n';
    mensaje += '¿Empezamos hoy? 🎓';

    // Escribir el mensaje en la columna N de la fila correcta (Sheets, como antes)
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var ultimaFila = sheet.getLastRow();
    sheet.getRange('N' + ultimaFila).setValue(mensaje);

    Logger.log('✅ Mensaje escrito en fila ' + ultimaFila + ' | ' + primerNombre + ' | ' + puntaje + '/5');

    // Enviar mensaje por WhatsApp
    if (whatsapp && whatsapp !== '') {
      var numeroLimpio = whatsapp.replace(/[\s\-\+]/g, '');
      var payload = JSON.stringify({
        messaging_product: 'whatsapp',
        to: numeroLimpio,
        type: 'text',
        text: { body: mensaje }
      });

      var options = {
        method: 'post',
        contentType: 'application/json',
        headers: {
          'Authorization': 'Bearer ' + PropertiesService.getScriptProperties().getProperty('WHATSAPP_TOKEN')
        },
        payload: payload,
        muteHttpExceptions: true
      };

      var response = UrlFetchApp.fetch('https://graph.facebook.com/v19.0/' + PHONE_NUMBER_ID + '/messages', options);
      Logger.log('WhatsApp response: ' + response.getContentText());

      // NUEVO: Escribir el mismo diagnóstico en Firestore para que el agente
      // vendedor tenga el contexto completo cuando el estudiante responda.
      var datosEstudiante = {
        nombre: nombreCompleto,
        examen: examen,
        fechaExamen: fechaExamen,
        puntaje: puntaje,
        fallas: fallas
      };
      actualizarEstudianteFirestore(whatsapp, mensaje, datosEstudiante);
    }

  } catch(error) {
    Logger.log('❌ Error: ' + error.toString());
  }
}
