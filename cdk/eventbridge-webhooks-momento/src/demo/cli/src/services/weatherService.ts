import type { WeatherData } from "../types.js";

const LOCATIONS = [
  "Seattle",
  "New York",
  "Los Angeles",
  "Chicago",
  "Houston",
  "Phoenix",
  "Philadelphia",
  "San Antonio",
  "San Diego",
  "Dallas",
] as const;

export class WeatherService {
  static generateRandomWeatherData(): WeatherData {
    const location = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];
    const maxTemp = Math.floor(Math.random() * 100).toString();
    const minTemp = Math.floor(Math.random() * parseInt(maxTemp)).toString();
    const precipitation = Math.floor(Math.random() * 100).toString();
    const ttl = "120"; // 2 minutes

    return { location, maxTemp, minTemp, precipitation, ttl };
  }
}
