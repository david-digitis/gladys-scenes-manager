# Scenes Manager — Gestionnaire d'ambiances intelligent pour Gladys

## Le contexte

En migrant de Home Assistant vers Gladys, un de mes plus gros defis a ete la gestion des **ambiances lumineuses**. J'ai 22 lumieres sur 4 protocoles differents (Philips Hue, Z-Wave, MQTT, Tuya) et je voulais des ambiances qui s'adaptent au moment de la journee et a la meteo.

Les scenes Gladys permettent de controler les lumieres, mais des qu'on veut gerer des variantes (couleurs plus chaudes quand il fait gris, ambiance differente jour/nuit), ca devient vite complexe avec beaucoup de scenes a maintenir.

J'ai donc cree un **Scenes Manager** : un container Docker leger (~25 Mo RAM) avec une interface web qui :

1. **Capture** l'etat de vos lumieres en un clic — tous les protocoles, via l'API Gladys
2. **Stocke** des presets avec des **variantes adaptatives** (jour/nuit, meteo)
3. **Applique** la bonne variante automatiquement quand une scene Gladys l'appelle

![Capture des lumieres](screenshot-capture-devices.png)
*Scan des lumieres : couleurs, luminosite, temperature — le tout capture depuis l'API Gladys, quel que soit le protocole.*

## Comment ca marche

```
Scene Gladys (trigger heure, presence, bouton, etc.)
  └→ Action "HTTP Request" : POST http://localhost:8890/scenes/soiree-chambre/apply
       └→ Scenes Manager
            ├─ Check : jour ou nuit ? (calcul local)
            ├─ Check : clair ou couvert ? (OpenWeatherMap, cache 10 min)
            └─ Applique la bonne variante via l'API Gladys
```

**Le point cle** : le Scenes Manager ne connait aucun protocole. Il passe par l'API Gladys (`POST /api/v1/device_feature/{selector}/value`). Si Gladys gere votre lumiere, le Scenes Manager la gere aussi.

**Separation des responsabilites** : Gladys decide **quand**, le Scenes Manager decide **comment**.

## Protocoles testes

| Protocole | Status |
|-----------|--------|
| Philips Hue | OK (on/off, brightness, color, temperature) |
| Z-Wave (Fibaro Dimmer) | OK (dimmer 0-99) |
| MQTT custom | OK (on/off, brightness, color) |
| Tuya | OK (on/off) |

## Performance

| Operation | Temps |
|-----------|-------|
| Capture 20 devices | ~80 ms |
| Appliquer 6 Hue en parallele | ~70 ms |

Negligeable — c'est le meme chemin de code que les scenes Gladys natives.

## Installation et documentation

Tout est sur GitHub avec le README complet, les instructions d'installation, la reference API et les screenshots :

**[GitHub — gladys-scenes-manager](https://github.com/VOTRE_USER/gladys-scenes-manager)**

En resume :
1. Cloner le repo
2. `docker build -t scenes-manager .`
3. `docker run` avec votre `presets.json` (config API key Gladys + coordonnees GPS)
4. Ouvrir `http://VOTRE_IP:8890`
5. Capturer vos ambiances, les appeler depuis les scenes Gladys via "HTTP Request"

## Stack

- Node.js 22 Alpine, 2 dependances (mqtt.js, suncalc)
- Frontend vanilla (HTML/CSS/JS), dark theme inspire de Gladys
- Pas de framework, pas de base de donnees — un fichier JSON

---

Developpe avec [Claude Code](https://claude.ai/claude-code). Retours et suggestions bienvenus !
