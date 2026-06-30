import { Router, type Response } from "express";

export const healthRouter = Router();

function sendHealth(response: Response) {
  response.status(200).json({
    status: "ok",
    service: "hold-jyu-elec-service"
  });
}

healthRouter.get("/", (_request, response) => {
  sendHealth(response);
});

healthRouter.get("/health", (_request, response) => {
  sendHealth(response);
});
