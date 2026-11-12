# Eiland, contenu

Le contenu public de l'app Eiland : des « îlots de langage » (des phrases regroupées par thème) et leurs audios.

Les audios sont générés automatiquement par une GitHub Action avec Azure Speech. L'app télécharge le `manifest.json` de sa langue, puis les mp3, et garde tout en cache pour fonctionner hors ligne.

## Structure

```
languages/
  index.json                   ← généré : la liste des langues disponibles
  nl-BE/
    language.json              ← réglages de la langue et de la voix
    islands/<id>.json          ← un fichier par îlot (c'est ce que tu modifies)
    audio/<phraseId>-<hash>.mp3 ← généré, ne pas modifier à la main
    manifest.json              ← généré, ne pas modifier à la main
scripts/build.mjs              ← validation, génération audio, manifest
.github/workflows/build-audio.yml
```

## Ajouter ou modifier un îlot

1. Crée `languages/nl-BE/islands/<id>.json`. Le nom du fichier doit être égal à l'`id`.

   ```json
   {
     "id": "sport",
     "emoji": "⚽",
     "title_fr": "Mon sport",
     "order": 160,
     "sentences": [
       { "id": "sport-001", "nl": "Ik speel voetbal.", "fr": "Je joue au foot." },
       { "id": "sport-002", "nl": "Ik heb goesting om te lopen.", "fr": "J'ai envie de courir.", "note": "« goesting » = envie." }
     ]
   }
   ```

   - `id` : minuscules, chiffres et tirets.
   - `order` : la position sur l'archipel (de 10 en 10, pour pouvoir en intercaler).
   - Phrases : `id`, `nl` et `fr` sont obligatoires, `note` est facultative. Il en faut au moins 2.
2. Pousse sur `main`. L'Action valide le fichier, génère seulement les audios nouveaux ou modifiés, met à jour le manifest et commite le résultat.
3. L'app voit le changement au prochain lancement.

**Ne change jamais l'`id` d'une phrase existante.** L'app range la progression (scores du rappel actif) par id. Pour corriger le texte d'une phrase, garde son id : l'audio est régénéré, et l'app remet le score de cette phrase à zéro. Pour ajouter une phrase au milieu d'un îlot, donne-lui un nouvel id (par exemple `cafe-021`) : c'est sa place dans la liste qui compte, pas son numéro.

## Vérifier en local

```sh
node scripts/build.mjs --validate-only   # valide, sans réseau
node scripts/build.mjs --dry-run         # liste les audios à générer ou supprimer
```

Pour générer en local, définis `AZURE_SPEECH_KEY` et `AZURE_SPEECH_REGION` dans ton terminal (jamais dans un fichier du dépôt), puis lance `node scripts/build.mjs`.

## Ajouter une langue

1. Crée `languages/<code>/language.json`, par exemple pour l'allemand :

   ```json
   { "code": "de-DE", "name": "Deutsch", "name_fr": "Allemand", "ui_lang": "fr", "voice": "de-DE-KatjaNeural", "rate": "0%" }
   ```

   La liste des voix : [Azure Speech, voix neuronales](https://learn.microsoft.com/azure/ai-services/speech-service/language-support?tabs=tts).
2. Ajoute ses îlots dans `languages/<code>/islands/`. Les ids de phrase doivent être uniques dans la langue. Le champ `nl` contient la phrase dans la langue apprise, quelle qu'elle soit.
3. Pousse : l'Action génère l'audio, `languages/<code>/manifest.json` et met à jour `languages/index.json`.

Changer `voice` ou `rate` dans `language.json` régénère tous les audios de la langue.

## Réglages GitHub (une seule fois)

- **Settings → Secrets and variables → Actions** : ajoute `AZURE_SPEECH_KEY` et `AZURE_SPEECH_REGION` (par exemple `westeurope`).
- **Settings → Actions → General → Workflow permissions** : « Read and write permissions ».

La clé reste dans les secrets GitHub. Elle n'est jamais dans le dépôt ni dans l'app.

## Adresses utilisées par l'app

- Manifest : `https://raw.githubusercontent.com/clementmtz/eiland-content/main/languages/nl-BE/manifest.json`
- Audio : `https://cdn.jsdelivr.net/gh/clementmtz/eiland-content@main/languages/nl-BE/<audio>`

Le hash dans le nom des mp3 garantit qu'un fichier ne change jamais : le cache de jsDelivr ne peut pas servir un audio périmé.

## Format audio

MP3 24 kHz mono 48 kbit/s. La vitesse est réglée dans l'app (lecture accélérée ou ralentie sans changer la hauteur de la voix), donc une seule version par phrase.
