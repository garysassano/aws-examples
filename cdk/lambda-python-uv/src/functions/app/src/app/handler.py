import sys

import pydantic
import pydantic_core._pydantic_core as pydantic_core_native
import report
from aws_lambda_powertools import Logger
from aws_lambda_powertools.utilities.parser import event_parser
from aws_lambda_powertools.utilities.typing import LambdaContext
from pydantic import BaseModel

logger = Logger()


class Event(BaseModel):
    name: str = "world"


@logger.inject_lambda_context
@event_parser(model=Event)
def handler(event: Event, context: LambdaContext) -> dict:
    # pydantic-core is a compiled extension with no pure-Python fallback, so importing it at all
    # proves the dependencies were built for this CPU.
    # The handler and report come from the function's code, pydantic from the dependencies layer.
    package = report.describe(
        sys.modules[__name__], report, pydantic, pydantic_core_native
    )
    logger.info("Package report", extra={"package": package})
    return {"greeting": f"Hello, {event.name}!", "package": package}
